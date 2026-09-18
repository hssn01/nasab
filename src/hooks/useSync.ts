import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, isConfigured } from '../lib/supabase'
import { getUnsyncedSessions, markSessionSynced } from '../localDb'

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
      // 1. Find all unsynced sessions in IndexedDB
      const unsyncedSessions = await getUnsyncedSessions()

      for (const session of unsyncedSessions) {
        // Upsert session to Supabase 'trees' table (last-write-wins)
        const stateToSave = session.linkedFrom
          ? { ...session.state, linkedFrom: session.linkedFrom }
          : session.state

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
