import { useCallback, useEffect, useState } from 'react'
import { supabase, isConfigured } from '../lib/supabase'
import {
  deleteSessionLocally,
  downloadSessionFromSupabase,
  getAllSessions,
} from '../localDb'
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
      if (navigator.onLine && isConfigured) {
        // Fetch from Supabase (trees or sessions table)
        let remoteList: { id: string; name: string; updated_at: string; state?: any }[] = []

        const { data: trees, error: tErr } = await supabase
          .from('trees')
          .select('id, name, updated_at, state')
          .order('updated_at', { ascending: false })

        if (!tErr && trees) {
          remoteList = trees
        } else {
          const { data: sess, error: sErr } = await supabase
            .from('sessions')
            .select('id, name, updated_at')
            .order('updated_at', { ascending: false })

          if (!sErr && sess) {
            remoteList = sess
          }
        }

        // Fetch local IndexedDB sessions
        const local = await getAllSessions()
        const localMap = new Map(local.map((s) => [s.id, s]))

        // Merge remote trees with local downloaded status
        const merged: TreeMeta[] = remoteList.map((remote) => {
          const localMatch = localMap.get(remote.id)
          const isDownloaded = Boolean(localMatch && localMatch.downloaded)
          const rootAncestor =
            remote.state?.root?.name || localMatch?.rootAncestor || remote.name

          return {
            id: remote.id,
            name: remote.name,
            updated_at: remote.updated_at,
            downloaded: isDownloaded,
            synced: true,
            rootAncestor,
          }
        })

        // Also add any local-only sessions that don't exist remotely yet
        const remoteIds = new Set(remoteList.map((r) => r.id))
        const localOnly = local.filter((l) => !remoteIds.has(l.id))
        for (const l of localOnly) {
          merged.push({
            id: l.id,
            name: l.name,
            updated_at: l.updated_at,
            downloaded: true,
            synced: l.synced ?? false,
            rootAncestor: l.rootAncestor || l.state?.root?.name || l.name,
          })
        }

        setSessions(merged)
        setSource('remote')
      } else {
        // Offline: fetch from IndexedDB only
        const local = await getAllSessions()
        // Only show sessions that were downloaded or created locally
        const downloadedSessions = local.filter((s) => s.downloaded !== false)

        setSessions(
          downloadedSessions.map((s) => ({
            id: s.id,
            name: s.name,
            updated_at: s.updated_at,
            downloaded: true,
            synced: s.synced ?? true,
            rootAncestor: s.rootAncestor || s.state?.root?.name || s.name,
          }))
        )
        setSource('local')
      }
    } catch (err: any) {
      console.error('Error loading session list:', err)
      setError(err?.message || 'فشل تحميل الجلسات')
      // Fallback to local
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
          }))
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

  // Download a single session to IndexedDB
  const downloadSession = useCallback(
    async (sessionId: string) => {
      if (!navigator.onLine || !isConfigured) return
      setDownloadingId(sessionId)
      try {
        await downloadSessionFromSupabase(sessionId, supabase)
        // Mark session as downloaded in state
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, downloaded: true } : s))
        )
      } catch (err) {
        console.error('Download failed:', err)
        alert('حدث خطأ أثناء تحميل الجلسة للعمل بدون إنترنت.')
      } finally {
        setDownloadingId(null)
      }
    },
    []
  )

  // Delete session
  const deleteSession = useCallback(async (sessionId: string) => {
    // Delete locally
    await deleteSessionLocally(sessionId)

    // If online, delete from Supabase
    if (navigator.onLine && isConfigured) {
      try {
        await supabase.from('trees').delete().eq('id', sessionId)
        await supabase.from('sessions').delete().eq('id', sessionId)
      } catch {
        // ignore
      }
    }

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
