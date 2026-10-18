import { supabase, isConfigured } from './lib/supabase'
import {
  deleteSessionLocally,
  getAllSessions,
  getSession,
  saveSessionLocally,
} from './localDb'
import { treeToRelational, relationalToTree } from './relationalAdapter'
import type {
  RelationalPerson,
  RelationalUnion,
  TreeLink,
  TreeMeta,
  TreeState,
} from './types'

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

// ── Helpers: write/read normalized relational rows in Supabase ──

/**
 * Upsert persons + unions rows for a tree to Supabase (dual-write).
 * Runs silently — errors are swallowed so the app keeps working.
 */
async function upsertRelationalRows(treeId: string, treeName: string, state: TreeState, now: string) {
  try {
    const bundle = treeToRelational(treeId, treeName, state, now)

    if (bundle.persons.length > 0) {
      const personsRows = bundle.persons.map((p) => ({
        id: p.id,
        tree_id: treeId,
        name: p.name,
        gender: p.gender,
        father_id: p.fatherId ?? null,
        mother_id: p.motherId ?? null,
        union_id: p.unionId ?? null,
        birth_order: p.birthOrder,
        notes: p.notes ?? null,
        branch_meta: p.branchMeta ?? null,
        updated_at: now,
      }))
      const { error: pErr } = await supabase
        .from('persons')
        .upsert(personsRows, { onConflict: 'tree_id,id', ignoreDuplicates: false })
      if (pErr) console.warn('[nasab] persons upsert:', pErr.message)
    }

    if (bundle.unions.length > 0) {
      const unionsRows = bundle.unions.map((u) => ({
        id: u.id,
        tree_id: treeId,
        husband_id: u.husbandId,
        type: u.type,
        wife_person_id: u.wifePersonId ?? null,
        wife_tree_id: u.wifeTreeId ?? null,
        wife_tree_name: u.wifeTreeName ?? null,
        wife_person_name: u.wifePersonName ?? null,
        wife_lineage_label: u.wifeLineageLabel ?? null,
        external_name: u.externalName ?? null,
        external_family: u.externalFamily ?? null,
        external_tribute: u.externalTribute ?? null,
        marriage_order: u.marriageOrder,
        notes: u.notes ?? null,
        updated_at: now,
      }))
      const { error: uErr } = await supabase
        .from('unions')
        .upsert(unionsRows, { onConflict: 'tree_id,id', ignoreDuplicates: false })
      if (uErr) console.warn('[nasab] unions upsert:', uErr.message)
    }
  } catch (err) {
    console.warn('[nasab] upsertRelationalRows failed silently:', err)
  }
}

/**
 * Delete all persons + unions for a tree from Supabase relational tables.
 */
async function deleteRelationalRows(treeId: string) {
  try {
    await Promise.all([
      supabase.from('persons').delete().eq('tree_id', treeId),
      supabase.from('unions').delete().eq('tree_id', treeId),
    ])
  } catch (err) {
    console.warn('[nasab] deleteRelationalRows failed silently:', err)
  }
}

interface SupabaseTreeMeta {
  name: string
  phase?: string
  root_person_id?: string | null
  male_counter?: number
  female_counter?: number
  males_queue?: string[]
  current_male_index?: number
  current_person_id?: string | null
  linked_from?: any
}

/**
 * Fetch relational persons + unions from Supabase and reconstruct TreeState.
 * Returns null if no relational rows exist yet (caller falls back to state blob).
 */
async function fetchRelationalState(treeId: string, meta: SupabaseTreeMeta): Promise<TreeState | null> {
  try {
    // Paginate persons in chunks of 1000 to overcome Supabase default limit
    let personsRaw: any[] = []
    let fromP = 0
    const step = 1000
    while (true) {
      const { data, error } = await supabase
        .from('persons')
        .select('*')
        .eq('tree_id', treeId)
        .range(fromP, fromP + step - 1)
      if (error || !data || data.length === 0) break
      personsRaw.push(...data)
      if (data.length < step) break
      fromP += step
    }

    if (personsRaw.length === 0) return null

    // Fetch all unions
    let unionsRaw: any[] = []
    let fromU = 0
    while (true) {
      const { data, error } = await supabase
        .from('unions')
        .select('*')
        .eq('tree_id', treeId)
        .range(fromU, fromU + step - 1)
      if (error || !data || data.length === 0) break
      unionsRaw.push(...data)
      if (data.length < step) break
      fromU += step
    }

    const persons: RelationalPerson[] = personsRaw.map((p: any) => ({
      id: p.id,
      treeId: p.tree_id,
      name: p.name,
      gender: p.gender,
      fatherId: p.father_id ?? null,
      motherId: p.mother_id ?? null,
      unionId: p.union_id ?? null,
      birthOrder: p.birth_order ?? 0,
      notes: p.notes ?? undefined,
      branchMeta: p.branch_meta ?? undefined,
      updated_at: p.updated_at,
      synced: true,
    }))

    const unions: RelationalUnion[] = unionsRaw.map((u: any) => ({
      id: u.id,
      treeId: u.tree_id,
      husbandId: u.husband_id,
      type: u.type,
      wifePersonId: u.wife_person_id ?? undefined,
      wifeTreeId: u.wife_tree_id ?? undefined,
      wifeTreeName: u.wife_tree_name ?? undefined,
      wifePersonName: u.wife_person_name ?? undefined,
      wifeLineageLabel: u.wife_lineage_label ?? undefined,
      externalName: u.external_name ?? undefined,
      externalFamily: u.external_family ?? undefined,
      externalTribute: u.external_tribute ?? undefined,
      marriageOrder: u.marriage_order ?? 0,
      notes: u.notes ?? undefined,
      updated_at: u.updated_at,
      synced: true,
    }))

    return relationalToTree({
      tree: {
        id: treeId,
        name: meta.name,
        rootPersonId: meta.root_person_id ?? null,
        phase: (meta.phase as any) ?? 'complete',
        currentPersonId: meta.current_person_id ?? null,
        maleCounter: meta.male_counter ?? 1,
        femaleCounter: meta.female_counter ?? 0,
        malesQueue: meta.males_queue ?? [],
        currentMaleIndex: meta.current_male_index ?? 0,
        linkedFrom: meta.linked_from ?? undefined,
        updated_at: new Date().toISOString(),
        synced: true,
      },
      persons,
      unions,
    })
  } catch (err) {
    console.warn('[nasab] fetchRelationalState failed silently:', err)
    return null
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
          linkedFrom: s.linkedFrom || s.state?.linkedFrom,
        }))
      }
    } catch {
      // ignore
    }
    return cached
  }

  try {
    const { data: safeData, error: safeErr } = await supabase
      .from('trees')
      .select('id, name, updated_at, state')
      .order('updated_at', { ascending: false })
      .limit(50)

    if (safeErr || !safeData) {
      return cached
    }
    const data = safeData

    const localSessions = await getAllSessions().catch(() => [])
    const localMap = new Map(localSessions.map((s) => [s.id, s]))

    const remoteTrees: TreeMeta[] = data.map((t: any) => {
      const stateObj = typeof t.state === 'string' ? JSON.parse(t.state) : t.state
      const local = localMap.get(t.id)
      const cachedItem = cached.find((c) => c.id === t.id)
      const linkedFrom =
        stateObj?.linkedFrom ||
        t.linked_from ||
        t.link ||
        local?.linkedFrom ||
        local?.state?.linkedFrom ||
        cachedItem?.linkedFrom

      return {
        id: t.id,
        name: t.name,
        updated_at: t.updated_at,
        downloaded: Boolean(local?.downloaded),
        synced: true,
        rootAncestor: stateObj?.root?.name || t.name,
        linkedFrom,
      }
    })

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
      .select('id, name, updated_at, state')
      .eq('id', id)
      .single()

    if (error || !data) {
      if (cached) return cached
      const local = await getSession(id)
      return local ? local.state : null
    }

    const local = await getSession(id)
    const treeListCached = getCachedTreeList()
    const metaMatch = treeListCached.find((t) => t.id === id)

    const rawState = data.state
    const stateObj: TreeState | undefined =
      typeof rawState === 'string' ? JSON.parse(rawState) : (rawState as TreeState | undefined)

    const effectiveLink: TreeLink | undefined =
      stateObj?.linkedFrom ||
      (data as any).linked_from ||
      (data as any).link ||
      cached?.linkedFrom ||
      local?.linkedFrom ||
      local?.state?.linkedFrom ||
      metaMatch?.linkedFrom

    // Always attempt reading normalized persons/unions first (highest fidelity)
    const relState = await fetchRelationalState(id, {
      name: data.name,
      phase: stateObj?.phase || 'complete',
      root_person_id: stateObj?.root?.id,
      male_counter: stateObj?.maleCounter,
      female_counter: stateObj?.femaleCounter,
      males_queue: stateObj?.malesQueue,
      current_male_index: stateObj?.currentMaleIndex,
      current_person_id: stateObj?.currentPersonId,
      linked_from: effectiveLink,
    })

    // Compare timestamps to protect any unsynced offline local edits
    const remoteTime = data.updated_at ? new Date(data.updated_at).getTime() : 0
    const localTime = local?.updated_at ? new Date(local.updated_at).getTime() : 0

    if (local && local.synced === false && localTime > remoteTime && local.state?.root) {
      console.log(`[nasab] Local has newer unsynced edits for tree ${id}, keeping local`)
      return local.state
    }

    let state: TreeState | null = null

    // Prefer stateObj: when edits are made from the internet/viewer, trees.state is the direct source of truth
    if (stateObj && stateObj.root) {
      state = {
        ...stateObj,
        linkedFrom: effectiveLink || stateObj.linkedFrom,
      }
    } else if (relState && relState.root) {
      state = {
        ...relState,
        linkedFrom: effectiveLink || relState.linkedFrom,
      }
    } else if (stateObj) {
      state = {
        ...stateObj,
        linkedFrom: effectiveLink || stateObj.linkedFrom,
      }
    } else if (relState) {
      state = {
        ...relState,
        linkedFrom: effectiveLink || relState.linkedFrom,
      }
    }

    if (state && effectiveLink && !state.linkedFrom) {
      state.linkedFrom = effectiveLink
    }

    // Keep relational tables up to date with the latest state
    if (state && state.root) {
      upsertRelationalRows(id, data.name, state, data.updated_at || new Date().toISOString())
    }

    if (!state) {
      if (cached) return cached
      return local ? local.state : null
    }

    setCachedState(id, state)

    // Update local IndexedDB if already downloaded
    if (local?.downloaded) {
      await saveSessionLocally(
        {
          id,
          name: data.name || local.name,
          state,
          updated_at: data.updated_at || new Date().toISOString(),
          downloaded: true,
          synced: true,
          linkedFrom: effectiveLink,
        },
        true
      )
    }

    // If local/cache had a linkedFrom that was missing from Supabase's state blob, sync it up
    if (state && effectiveLink && !stateObj?.linkedFrom) {
      void supabase
        .from('trees')
        .update({ state, updated_at: new Date().toISOString() })
        .eq('id', id)
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
  state: TreeState,
  link?: TreeLink
): Promise<string | null> {
  const localId = crypto.randomUUID ? crypto.randomUUID() : 'tree-' + Date.now()
  const now = new Date().toISOString()
  const stateWithLink: TreeState = link ? { ...state, linkedFrom: link } : state

  // Save locally first in localStorage AND IndexedDB so the app works 100% offline
  setCachedState(localId, stateWithLink)
  await saveSessionLocally({
    id: localId,
    name,
    state: stateWithLink,
    updated_at: now,
    downloaded: true,
    synced: false,
    rootAncestor: state.root?.name || name,
    linkedFrom: link,
  })

  const currentList = getCachedTreeList()
  const updatedList: TreeMeta[] = [
    { id: localId, name, updated_at: now, downloaded: true, synced: false, linkedFrom: link },
    ...currentList.filter((t) => t.id !== localId),
  ]
  setCachedTreeList(updatedList)

  if (!navigator.onLine || !isConfigured) {
    return localId
  }

  try {
    // Build the tree row with both blob and relational columns
    const bundle = treeToRelational(localId, name, stateWithLink, now)
    const treeRow: any = {
      name,
      state: stateWithLink,          // dual-write: keep blob for backward compat
      root_person_id: bundle.tree.rootPersonId ?? null,
      phase: bundle.tree.phase,
      current_person_id: bundle.tree.currentPersonId ?? null,
      male_counter: bundle.tree.maleCounter,
      female_counter: bundle.tree.femaleCounter,
      males_queue: bundle.tree.malesQueue,
      current_male_index: bundle.tree.currentMaleIndex,
      linked_from: link ?? null,
    }

    let realId: string = localId
    const { data, error } = await supabase
      .from('trees')
      .insert(treeRow)
      .select('id')
      .single()

    if (error || !data) {
      // Fallback: insert with basic columns only
      const blobRow: any = {
        name,
        state: stateWithLink,
        updated_at: now,
      }
      const { data: bData, error: bErr } = await supabase
        .from('trees')
        .insert(blobRow)
        .select('id')
        .single()

      if (bErr || !bData) {
        console.warn('[nasab] createTree failed on Supabase:', bErr || error)
        return localId
      }
      realId = bData.id as string
    } else {
      realId = data.id as string
    }

    // Write relational persons + unions rows
    await upsertRelationalRows(realId, name, stateWithLink, now)

    // If Supabase created a different UUID, update local caches
    if (realId !== localId) {
      localStorage.removeItem(CACHE_PREFIX + localId)
      await deleteSessionLocally(localId)

      setCachedState(realId, stateWithLink)
      await saveSessionLocally(
        {
          id: realId,
          name,
          state: stateWithLink,
          updated_at: now,
          downloaded: true,
          synced: true,
          rootAncestor: state.root?.name || name,
          linkedFrom: link,
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
        state: stateWithLink,
        updated_at: now,
        downloaded: true,
        synced: true,
        rootAncestor: state.root?.name || name,
        linkedFrom: link,
      },
      true
    )

    return localId
  } catch {
    return localId
  }
}

export async function saveTreeState(id: string, state: TreeState): Promise<void> {
  // CRITICAL DATA PROTECTION: Never overwrite an existing tree that already has a root with an empty root
  if (!state.root) {
    const cached = getCachedState(id)
    if (cached?.root) {
      console.warn(`[nasab] Guard triggered: Refusing to overwrite tree ${id} with empty root. Existing root: ${cached.root.name}`)
      return
    }
  }

  const now = new Date().toISOString()
  const name = state.root?.name ? `شجرة ${state.root.name}` : undefined

  // Update in IndexedDB (marked synced: false initially until uploaded)
  const existing = await getSession(id)
  const cached = getCachedState(id)
  const effectiveLinkedFrom = state.linkedFrom || existing?.linkedFrom || existing?.state?.linkedFrom || cached?.linkedFrom
  const finalState: TreeState = effectiveLinkedFrom ? { ...state, linkedFrom: effectiveLinkedFrom } : state
  const sessionName = name || existing?.name || 'شجرتي'

  // Always update local cache instantly with full linked state
  setCachedState(id, finalState)

  await saveSessionLocally({
    id,
    name: sessionName,
    state: finalState,
    updated_at: now,
    downloaded: true,
    synced: false,
    rootAncestor: finalState.root?.name || existing?.rootAncestor || sessionName,
    linkedFrom: effectiveLinkedFrom,
  })

  // Update metadata cache
  const list = getCachedTreeList()
  const treeIndex = list.findIndex((t) => t.id === id)
  if (treeIndex !== -1) {
    list[treeIndex].updated_at = now
    if (name) list[treeIndex].name = name
    list[treeIndex].linkedFrom = effectiveLinkedFrom
    setCachedTreeList([...list])
  }

  if (!navigator.onLine || !isConfigured) return

  try {
    const payload: any = { state: finalState, updated_at: now }
    if (name) payload.name = name

    const { error } = await supabase.from('trees').update(payload).eq('id', id)

    // Write normalized rows in parallel (no await — don't block the save)
    upsertRelationalRows(id, sessionName, finalState, now)

    if (!error) {
      await saveSessionLocally(
        {
          id,
          name: sessionName,
          state: finalState,
          updated_at: now,
          downloaded: true,
          synced: true,
          rootAncestor: finalState.root?.name || sessionName,
          linkedFrom: effectiveLinkedFrom,
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
    // Delete relational rows first (also handled by ON DELETE CASCADE on DB,
    // but explicit delete ensures cleanup even if cascade isn't configured yet)
    await deleteRelationalRows(id)
    await supabase.from('trees').delete().eq('id', id)
  } catch {
    // Deleted locally
  }
}

export async function updateTreeLink(id: string, link: TreeLink | null): Promise<void> {
  const existing = await getSession(id)
  const cachedState = getCachedState(id)
  let baseState = existing?.state || cachedState

  if (!baseState) {
    baseState = await fetchTreeState(id)
  }

  const nextState: TreeState = baseState
    ? { ...baseState, linkedFrom: link ?? undefined }
    : ({
        root: null,
        phase: 'setup',
        currentPersonId: null,
        maleCounter: 1,
        femaleCounter: 0,
        malesQueue: [],
        currentMaleIndex: 0,
        linkedFrom: link ?? undefined,
      } as TreeState)

  setCachedState(id, nextState)

  const list = getCachedTreeList()
  const idx = list.findIndex((t) => t.id === id)
  if (idx !== -1) {
    list[idx] = { ...list[idx], linkedFrom: link ?? undefined }
    setCachedTreeList([...list])
  }

  const sessionName = existing?.name || (idx !== -1 ? list[idx].name : 'شجرة')
  await saveSessionLocally({
    id,
    name: sessionName,
    state: nextState,
    linkedFrom: link ?? undefined,
    synced: false,
    downloaded: existing?.downloaded ?? true,
    updated_at: new Date().toISOString(),
  })

  if (!navigator.onLine || !isConfigured) return

  try {
    const { error } = await supabase
      .from('trees')
      .update({ state: nextState, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (!error) {
      await saveSessionLocally(
        {
          id,
          name: sessionName,
          state: nextState,
          linkedFrom: link ?? undefined,
          synced: true,
          downloaded: existing?.downloaded ?? true,
          updated_at: new Date().toISOString(),
        },
        true
      )
    }
  } catch (err) {
    console.warn('[nasab] updateTreeLink failed:', err)
  }
}

/**
 * One-time Supabase migration: reads all trees that only have a state blob
 * and backfills their persons + unions into the relational tables.
 * Safe to call on every app start — skips trees that already have relational rows.
 */
export async function migrateSupabaseToRelational(): Promise<void> {
  if (!navigator.onLine || !isConfigured) return

  const SUPA_MIGRATION_KEY = 'nasab-supabase-relational-migration-v1'
  if (localStorage.getItem(SUPA_MIGRATION_KEY) === 'done') return

  try {
    const { data: trees, error } = await supabase
      .from('trees')
      .select('id, name, state, updated_at')
      .order('updated_at', { ascending: false })
      .limit(200)

    if (error || !trees) return

    let migrated = 0

    for (const tree of trees) {
      if (!tree.state?.root) continue

      // Check if relational persons already exist
      const { data: existing } = await supabase
        .from('persons')
        .select('id')
        .eq('tree_id', tree.id)
        .limit(1)

      if (existing && existing.length > 0) continue

      await upsertRelationalRows(
        tree.id,
        tree.name,
        tree.state,
        tree.updated_at || new Date().toISOString()
      )
      migrated++
    }

    localStorage.setItem(SUPA_MIGRATION_KEY, 'done')
    if (migrated > 0) {
      console.log(`[nasab] Migrated ${migrated} Supabase trees to relational format`)
    }
  } catch (err) {
    console.warn('[nasab] Supabase relational migration failed, will retry next load:', err)
  }
}

