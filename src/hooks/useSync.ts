import { useCallback, useEffect, useRef, useState } from 'react'
import { isConfigured } from '../lib/supabase'
import {
  getAllSessions,
  getUnsyncedSessions,
  markSessionSynced,
  saveSessionLocally,
} from '../localDb'
import { fetchDeviceTrees, fetchTreeState, saveTreeState } from '../db'
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
      const unsyncedSessions = await getUnsyncedSessions()

      for (const session of unsyncedSessions) {
        const saved = await saveTreeState(session.id, session.state)
        // A guarded save (e.g. an explicit wife deletion whose pending shot
        // has not reached the cloud yet) must stay unsynced so it can retry.
        if (saved) await markSessionSynced(session.id)
      }

      const remoteTrees = await fetchDeviceTrees()
      const allLocal = await getAllSessions()
      const localMap = new Map(allLocal.map((s) => [s.id, s]))

      for (const remote of remoteTrees) {
        const local = localMap.get(remote.id)
        const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0
        const localTime = local?.updated_at ? new Date(local.updated_at).getTime() : 0

        if (local?.synced !== false && remoteTime > localTime) {
          const cloudState = await fetchTreeState(remote.id)
          if (cloudState) {
            setCachedState(remote.id, cloudState)
            await saveSessionLocally(
              {
                id: remote.id,
                name: remote.name,
                state: cloudState,
                updated_at: remote.updated_at,
                downloaded: local?.downloaded ?? true,
                synced: true,
                linkedFrom: cloudState.linkedFrom || local?.linkedFrom,
              },
              true,
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

  useEffect(() => {
    function handleOnline() {
      void syncPending()
    }

    window.addEventListener('online', handleOnline)
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