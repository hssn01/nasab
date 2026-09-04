import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, isConfigured } from '../lib/supabase'
import { getDb, getUnsyncedSessions, markSessionSynced } from '../localDb'

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
        const { error: treeErr } = await supabase
          .from('trees')
          .upsert(
            {
              id: session.id,
              name: session.name,
              state: session.state,
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

      // 2. Also check if there are any unsynced persons in IndexedDB
      const db = await getDb()
      const allPersons = await db.getAll<any>('persons')
      const unsyncedPersons = allPersons.filter((p) => p.synced === false)

      for (const person of unsyncedPersons) {
        try {
          const { error: pErr } = await supabase
            .from('persons')
            .upsert(
              {
                id: person.id,
                sessionId: person.sessionId,
                name: person.name,
                gender: person.gender,
                wives: person.wives,
                children: person.children,
                updated_at: person.updated_at || new Date().toISOString(),
              },
              {
                onConflict: 'id',
                ignoreDuplicates: false,
              }
            )

          if (!pErr) {
            await db.put('persons', { ...person, synced: true })
          }
        } catch {
          // Ignore if persons table is not present
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
