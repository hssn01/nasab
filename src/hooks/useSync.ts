import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, isConfigured } from '../lib/supabase'
import {
  getAllSessions,
  getUnsyncedSessions,
  markSessionSynced,
  saveSessionLocally,
} from '../localDb'
import { setCachedState } from '../db'

export function useSync() {
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const isSyncingRef = useRef(false)

  const syncPending = useCallback(async () => {
    if (!navigator.onLine || !isConfigured || isSyncingRef.current) return

    isSyncingRef.current = true
    setIsSyncing(true)
    setSyncError(null)

    try {
      // 1. Find all unsynced sessions in IndexedDB and push to Supabase
      const unsyncedSessions = await getUnsyncedSessions()

      for (const session of unsyncedSessions) {
        // Upsert session to Supabase 'trees' table (last-write-wins)
        let stateToSave = session.linkedFrom
          ? { ...session.state, linkedFrom: session.linkedFrom }
          : session.state

        // Guard: If local state lacks linkedFrom, check if Supabase already has one to avoid wiping it
        if (!stateToSave?.linkedFrom) {
          const { data: remoteTree } = await supabase
            .from('trees')
            .select('state')
            .eq('id', session.id)
            .single()
          if (remoteTree?.state?.linkedFrom) {
            stateToSave = { ...stateToSave, linkedFrom: remoteTree.state.linkedFrom }
          }
        }

        const { error: treeErr } = await supabase
          .from('trees')
          .upsert(
            {
              id: session.id,
              name: session.name,
              state: stateToSave,
              updated_at: session.updated_at || new Date().toISOString(),
            },
            {
              onConflict: 'id',
              ignoreDuplicates: false,
            }
          )

        if (!treeErr) {
          await markSessionSynced(session.id)
        } else {
          // If 'trees' failed, check if 'sessions' table exists
          const { error: sessErr } = await supabase
            .from('sessions')
            .upsert(
              {
                id: session.id,
                name: session.name,
                updated_at: session.updated_at || new Date().toISOString(),
              },
              {
                onConflict: 'id',
                ignoreDuplicates: false,
              }
            )

          if (!sessErr) {
            await markSessionSynced(session.id)
          }
        }
      }

      // 2. Bidirectional pull: Fetch remote trees and update local if remote was updated on the internet
      const allLocal = await getAllSessions()
      const localMap = new Map(allLocal.map((s) => [s.id, s]))

      const { data: remoteTrees } = await supabase
        .from('trees')
        .select('id, name, updated_at, state')

      if (remoteTrees) {
        for (const remote of remoteTrees) {
          const local = localMap.get(remote.id)
          const rState = typeof remote.state === 'string' ? JSON.parse(remote.state) : remote.state
          if (!rState || !rState.root) continue

          const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0
          const localTime = local?.updated_at ? new Date(local.updated_at).getTime() : 0

          // If remote is newer and local has no pending unsynced edits, pull it into local
          if (local?.synced !== false && remoteTime > localTime) {
            setCachedState(remote.id, rState)
            await saveSessionLocally(
              {
                id: remote.id,
                name: remote.name,
                state: rState,
                updated_at: remote.updated_at,
                downloaded: local?.downloaded ?? true,
                synced: true,
                linkedFrom: rState.linkedFrom || local?.linkedFrom,
              },
              true
            )
          }
        }
      }

      setLastSyncTime(new Date())
    } catch (err: any) {
      setSyncError(err?.message || 'Sync failed')
    } finally {
      setIsSyncing(false)
      isSyncingRef.current = false
    }
  }, [])

  // Auto-sync on online event
  useEffect(() => {
    function handleOnline() {
      void syncPending()
    }

    window.addEventListener('online', handleOnline)
    // Run once on mount if online
    if (navigator.onLine) {
      void syncPending()
    }

    return () => {
      window.removeEventListener('online', handleOnline)
    }
  }, [syncPending])

  return {
    isSyncing,
    lastSyncTime,
    syncError,
    syncNow: syncPending,
  }
}
