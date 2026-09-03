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
  localStorage.setItem(CACHE_PREFIX + treeId, JSON.stringify(state))
}

// ── Supabase CRUD ──

export async function fetchDeviceTrees(): Promise<TreeMeta[]> {
  if (!isConfigured) return []
  const { data } = await supabase
    .from('trees')
    .select('id, name, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50)
  return (data ?? []) as TreeMeta[]
}


export async function fetchTreeState(id: string): Promise<TreeState | null> {
  if (!isConfigured) return null
  const { data } = await supabase
    .from('trees')
    .select('state')
    .eq('id', id)
    .single()
  return data ? (data.state as TreeState) : null
}

export async function createTree(
  name: string,
  state: TreeState,
): Promise<string | null> {
  if (!isConfigured) return null
  const { data } = await supabase
    .from('trees')
    .insert({ name, state })
    .select('id')
    .single()
  if (!data) return null
  registerDeviceTree(data.id as string)
  return data.id as string
}

export async function saveTreeState(id: string, state: TreeState): Promise<void> {
  if (!isConfigured) return
  await supabase.from('trees').update({ state }).eq('id', id)
}

export async function renameTree(id: string, name: string): Promise<void> {
  if (!isConfigured) return
  await supabase.from('trees').update({ name }).eq('id', id)
}

export async function deleteTree(id: string): Promise<void> {
  if (!isConfigured) return
  await supabase.from('trees').delete().eq('id', id)
  unregisterDeviceTree(id)
  localStorage.removeItem(CACHE_PREFIX + id)
}
