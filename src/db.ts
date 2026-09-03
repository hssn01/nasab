import { supabase, isConfigured } from './lib/supabase'
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
    return cached
  }

  try {
    const { data, error } = await supabase
      .from('trees')
      .select('id, name, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50)

    if (error || !data) {
      return cached
    }

    const remoteTrees = data as TreeMeta[]

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
    return cached
  }

  try {
    const { data, error } = await supabase
      .from('trees')
      .select('state')
      .eq('id', id)
      .single()

    if (error || !data) {
      return cached
    }

    const state = data.state as TreeState
    setCachedState(id, state)
    return state
  } catch {
    return cached
  }
}

export async function createTree(
  name: string,
  state: TreeState,
): Promise<string | null> {
  const localId = crypto.randomUUID ? crypto.randomUUID() : 'tree-' + Date.now()
  const now = new Date().toISOString()

  // Save locally first so the app works 100% offline
  setCachedState(localId, state)
  const currentList = getCachedTreeList()
  const updatedList: TreeMeta[] = [
    { id: localId, name, updated_at: now },
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

    // If Supabase created a different UUID, update local cache
    if (realId !== localId) {
      localStorage.removeItem(CACHE_PREFIX + localId)
      setCachedState(realId, state)

      const finalTreeList = updatedList.map((t) =>
        t.id === localId ? { ...t, id: realId } : t,
      )
      setCachedTreeList(finalTreeList)
      return realId
    }

    return localId
  } catch {
    return localId
  }
}

export async function saveTreeState(id: string, state: TreeState): Promise<void> {
  // Always update local cache instantly
  setCachedState(id, state)

  // Update updated_at in local tree list metadata
  const list = getCachedTreeList()
  const treeIndex = list.findIndex((t) => t.id === id)
  if (treeIndex !== -1) {
    list[treeIndex].updated_at = new Date().toISOString()
    if (state.root?.name) {
      list[treeIndex].name = `شجرة ${state.root.name}`
    }
    setCachedTreeList([...list])
  }

  if (!navigator.onLine || !isConfigured) return

  try {
    await supabase.from('trees').update({ state }).eq('id', id)
  } catch {
    // Will auto-sync when online
  }
}

export async function renameTree(id: string, name: string): Promise<void> {
  const list = getCachedTreeList()
  const tree = list.find((t) => t.id === id)
  if (tree) {
    tree.name = name
    setCachedTreeList([...list])
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

  if (!navigator.onLine || !isConfigured) return

  try {
    await supabase.from('trees').delete().eq('id', id)
  } catch {
    // Deleted locally
  }
}

