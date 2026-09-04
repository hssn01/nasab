import { supabase, isConfigured } from './lib/supabase'
import {
  deleteSessionLocally,
  getAllSessions,
  getSession,
  saveSessionLocally,
} from './localDb'
import type { TreeMeta, TreeState } from './types'

// ── Device tree registry (localStorage list of IDs this device knows about) ──

const DEVICE_TREES_KEY = 'nasab-device-trees-v1'
const CACHE_PREFIX = 'nasab-cache-v1-'

export function getDeviceTreeIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_TREES_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

function saveDeviceTreeIds(ids: string[]) {
  localStorage.setItem(DEVICE_TREES_KEY, JSON.stringify(ids))
}

export function registerDeviceTree(id: string) {
  const ids = getDeviceTreeIds()
  if (!ids.includes(id)) saveDeviceTreeIds([id, ...ids])
}

export function unregisterDeviceTree(id: string) {
  saveDeviceTreeIds(getDeviceTreeIds().filter((i) => i !== id))
}

// ── Local cache (fast read on mount, fallback when offline) ──

export function getCachedState(treeId: string): TreeState | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + treeId)
    return raw ? (JSON.parse(raw) as TreeState) : null
  } catch {
    return null
  }
}

export function setCachedState(treeId: string, state: TreeState) {
  try {
    localStorage.setItem(CACHE_PREFIX + treeId, JSON.stringify(state))
  } catch {
    // Ignore storage quota errors
  }
}

// ── Supabase CRUD ──

const METADATA_CACHE_KEY = 'nasab-trees-metadata-v1'

export function getCachedTreeList(): TreeMeta[] {
  try {
    const raw = localStorage.getItem(METADATA_CACHE_KEY)
    return raw ? (JSON.parse(raw) as TreeMeta[]) : []
  } catch {
    return []
  }
}

export function setCachedTreeList(trees: TreeMeta[]) {
  try {
    localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(trees))
  } catch {
    // Ignore storage quota errors
  }
}

// ── Supabase CRUD with Offline Fallback ──

export async function fetchDeviceTrees(): Promise<TreeMeta[]> {
  const cached = getCachedTreeList()

  if (!navigator.onLine || !isConfigured) {
    // Merge with IndexedDB sessions
    try {
      const localSessions = await getAllSessions()
      if (localSessions.length > 0) {
        return localSessions.map((s) => ({
          id: s.id,
          name: s.name,
          updated_at: s.updated_at,
          downloaded: true,
          synced: s.synced ?? true,
          rootAncestor: s.rootAncestor || s.state?.root?.name || s.name,
        }))
      }
    } catch {
      // ignore
    }
    return cached
  }

  try {
    const { data, error } = await supabase
      .from('trees')
      .select('id, name, updated_at, state')
      .order('updated_at', { ascending: false })
      .limit(50)

    if (error || !data) {
      return cached
    }

    const localSessions = await getAllSessions().catch(() => [])
    const localMap = new Map(localSessions.map((s) => [s.id, s]))

    const remoteTrees: TreeMeta[] = data.map((t: any) => ({
      id: t.id,
      name: t.name,
      updated_at: t.updated_at,
      downloaded: Boolean(localMap.get(t.id)?.downloaded),
      synced: true,
      rootAncestor: t.state?.root?.name || t.name,
    }))

    // Merge remote trees with any local-only offline trees
    const remoteIds = new Set(remoteTrees.map((t) => t.id))
    const localOnly = cached.filter((t) => !remoteIds.has(t.id))
    const merged = [...localOnly, ...remoteTrees]

    setCachedTreeList(merged)
    return merged
  } catch {
    return cached
  }
}

export async function fetchTreeState(id: string): Promise<TreeState | null> {
  const cached = getCachedState(id)

  if (!navigator.onLine || !isConfigured) {
    if (cached) return cached
    const local = await getSession(id)
    return local ? local.state : null
  }

  try {
    const { data, error } = await supabase
      .from('trees')
      .select('state, name, updated_at')
      .eq('id', id)
      .single()

    if (error || !data) {
      if (cached) return cached
      const local = await getSession(id)
      return local ? local.state : null
    }

    const state = data.state as TreeState
    setCachedState(id, state)
    // Update local IndexedDB if already downloaded
    const local = await getSession(id)
    if (local?.downloaded) {
      await saveSessionLocally(
        {
          id,
          name: data.name || local.name,
          state,
          updated_at: data.updated_at || new Date().toISOString(),
          downloaded: true,
          synced: true,
        },
        true
      )
    }
    return state
  } catch {
    if (cached) return cached
    const local = await getSession(id)
    return local ? local.state : null
  }
}

export async function createTree(
  name: string,
  state: TreeState
): Promise<string | null> {
  const localId = crypto.randomUUID ? crypto.randomUUID() : 'tree-' + Date.now()
  const now = new Date().toISOString()

  // Save locally first in localStorage AND IndexedDB so the app works 100% offline
  setCachedState(localId, state)
  await saveSessionLocally({
    id: localId,
    name,
    state,
    updated_at: now,
    downloaded: true,
    synced: false,
    rootAncestor: state.root?.name || name,
  })

  const currentList = getCachedTreeList()
  const updatedList: TreeMeta[] = [
    { id: localId, name, updated_at: now, downloaded: true, synced: false },
    ...currentList.filter((t) => t.id !== localId),
  ]
  setCachedTreeList(updatedList)

  if (!navigator.onLine || !isConfigured) {
    return localId
  }

  try {
    const { data, error } = await supabase
      .from('trees')
      .insert({ name, state })
      .select('id')
      .single()

    if (error || !data) {
      return localId
    }

    const realId = data.id as string

    // If Supabase created a different UUID, update local caches
    if (realId !== localId) {
      localStorage.removeItem(CACHE_PREFIX + localId)
      await deleteSessionLocally(localId)

      setCachedState(realId, state)
      await saveSessionLocally(
        {
          id: realId,
          name,
          state,
          updated_at: now,
          downloaded: true,
          synced: true,
          rootAncestor: state.root?.name || name,
        },
        true
      )

      const finalTreeList = updatedList.map((t) =>
        t.id === localId ? { ...t, id: realId, synced: true } : t
      )
      setCachedTreeList(finalTreeList)
      return realId
    }

    // Mark synced in IndexedDB
    await saveSessionLocally(
      {
        id: localId,
        name,
        state,
        updated_at: now,
        downloaded: true,
        synced: true,
        rootAncestor: state.root?.name || name,
      },
      true
    )

    return localId
  } catch {
    return localId
  }
}

export async function saveTreeState(id: string, state: TreeState): Promise<void> {
  const now = new Date().toISOString()
  const name = state.root?.name ? `شجرة ${state.root.name}` : undefined

  // Always update local cache instantly
  setCachedState(id, state)

  // Update in IndexedDB (marked synced: false initially until uploaded)
  const existing = await getSession(id)
  const sessionName = name || existing?.name || 'شجرتي'

  await saveSessionLocally({
    id,
    name: sessionName,
    state,
    updated_at: now,
    downloaded: true,
    synced: false,
    rootAncestor: state.root?.name || existing?.rootAncestor || sessionName,
  })

  // Update metadata cache
  const list = getCachedTreeList()
  const treeIndex = list.findIndex((t) => t.id === id)
  if (treeIndex !== -1) {
    list[treeIndex].updated_at = now
    if (name) list[treeIndex].name = name
    setCachedTreeList([...list])
  }

  if (!navigator.onLine || !isConfigured) return

  try {
    const payload: any = { state, updated_at: now }
    if (name) payload.name = name

    const { error } = await supabase.from('trees').update(payload).eq('id', id)
    if (!error) {
      await saveSessionLocally(
        {
          id,
          name: sessionName,
          state,
          updated_at: now,
          downloaded: true,
          synced: true,
          rootAncestor: state.root?.name || sessionName,
        },
        true
      )
    }
  } catch {
    // Will auto-sync via useSync
  }
}

export async function renameTree(id: string, name: string): Promise<void> {
  const list = getCachedTreeList()
  const tree = list.find((t) => t.id === id)
  if (tree) {
    tree.name = name
    setCachedTreeList([...list])
  }

  const existing = await getSession(id)
  if (existing) {
    await saveSessionLocally({ ...existing, name })
  }

  if (!navigator.onLine || !isConfigured) return

  try {
    await supabase.from('trees').update({ name }).eq('id', id)
  } catch {
    // Saved locally
  }
}

export async function deleteTree(id: string): Promise<void> {
  const list = getCachedTreeList().filter((t) => t.id !== id)
  setCachedTreeList(list)
  localStorage.removeItem(CACHE_PREFIX + id)

  await deleteSessionLocally(id)

  if (!navigator.onLine || !isConfigured) return

  try {
    await supabase.from('trees').delete().eq('id', id)
  } catch {
    // Deleted locally
  }
}
