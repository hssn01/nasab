import { useCallback, useEffect, useState } from 'react'
import { isConfigured } from '../lib/supabase'
import { downloadSessionFromSupabase, getAllSessions } from '../localDb'
import { deleteTree, fetchDeviceTrees } from '../db'
import type { TreeMeta } from '../types'

export function useSessionList() {
  const [sessions, setSessions] = useState<TreeMeta[]>([])
  const [source, setSource] = useState<'remote' | 'local'>('local')
  const [loading, setLoading] = useState(true)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const merged = await fetchDeviceTrees()
      setSessions(merged)
      setSource(navigator.onLine && isConfigured ? 'remote' : 'local')
    } catch (err: any) {
      console.error('Error loading session list:', err)
      setError(err?.message || 'Failed to load trees')
      try {
        const local = await getAllSessions()
        setSessions(
          local.map((s) => ({
            id: s.id,
            name: s.name,
            updated_at: s.updated_at,
            downloaded: true,
            synced: s.synced ?? true,
            rootAncestor: s.rootAncestor || s.state?.root?.name || s.name,
            linkedFrom: s.linkedFrom || s.state?.linkedFrom,
          })),
        )
        setSource('local')
      } catch {
        // ignore
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()

    function handleOnline() {
      void load()
    }
    function handleOffline() {
      void load()
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [load])

  const downloadSession = useCallback(
    async (sessionId: string) => {
      if (!navigator.onLine || !isConfigured) return
      setDownloadingId(sessionId)
      try {
        await downloadSessionFromSupabase(sessionId, (await import('../lib/supabase')).supabase)
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, downloaded: true } : s))
        )
      } catch (err) {
        console.error('Download failed:', err)
        alert('Download failed.')
      } finally {
        setDownloadingId(null)
      }
    },
    []
  )

  const deleteSession = useCallback(async (sessionId: string) => {
    await deleteTree(sessionId)
    setSessions((prev) => prev.filter((s) => s.id !== sessionId))
  }, [])

  return {
    sessions,
    source,
    loading,
    downloadingId,
    error,
    downloadSession,
    deleteSession,
    refresh: load,
  }
}