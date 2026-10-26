import { supabase, isConfigured } from './lib/supabase'
import { ensureEditorSession } from './lib/editorAuth'
import {
  deleteSessionLocally,
  getAllSessions,
  getSession,
  saveSessionLocally,
} from './localDb'
import { relationalToTree, treeToRelational } from './relationalAdapter'
import { validateTreeForSave } from './treeUtils'
import type {
  Person,
  RelationalPerson,
  RelationalTreeBundle,
  RelationalUnion,
  TreeLink,
  TreeMeta,
  TreeState,
} from './types'

// Device tree registry (localStorage list of IDs this device knows about)
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

// Local cache
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

// Helpers
async function fetchPersons(treeId: string): Promise<RelationalPerson[]> {
  const rows: any[] = []
  let from = 0
  const step = 1000
  while (true) {
    const { data, error } = await supabase
      .from('persons')
      .select('*')
      .eq('tree_id', treeId)
      .range(from, from + step - 1)
    // Never return a partial/empty tree silently: a failed page looks like a
    // tree with no persons, and saving that state would wipe the cloud copy.
    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < step) break
    from += step
  }
  return rows.map((p) => ({
    id: p.id,
    treeId: p.tree_id,
    code: p.code,
    name: p.name,
    gender: p.gender,
    fatherId: p.father_id ?? null,
    motherUnionId: p.mother_union_id ?? null,
    siblingOrder: p.sibling_order ?? 0,
    notes: p.notes ?? undefined,
    branchMeta: p.branch_meta ?? undefined,
    updated_at: p.updated_at,
    synced: true,
  }))
}

async function fetchUnions(treeId: string): Promise<RelationalUnion[]> {
  const rows: any[] = []
  let from = 0
  const step = 1000
  while (true) {
    const { data, error } = await supabase
      .from('unions')
      .select('*')
      .eq('tree_id', treeId)
      .range(from, from + step - 1)
    // A failed unions page must fall back to the cache, not masquerade as a
    // wife-less tree (that is how canonical unions get wiped on the next save).
    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < step) break
    from += step
  }
  return rows.map((u) => ({
    id: u.id,
    treeId: u.tree_id,
    code: u.code,
    husbandId: u.husband_id,
    wifePersonId: u.wife_person_id ?? undefined,
    externalName: u.external_name ?? undefined,
    externalFamily: u.external_family ?? undefined,
    externalTribute: u.external_tribe ?? undefined,
    marriageOrder: u.marriage_order ?? 0,
    legacy: u.legacy ?? undefined,
    notes: u.notes ?? undefined,
    updated_at: u.updated_at,
    synced: true,
  }))
}

async function fetchLinkedFrom(branchTreeId: string): Promise<TreeLink | undefined> {
  try {
    const { data: links } = await supabase
      .from('tree_links')
      .select('*')
      .eq('branch_tree_id', branchTreeId)
      .limit(1)
    if (!links || links.length === 0) return undefined
    const link = links[0]
    const { data: mainTree } = await supabase
      .from('trees')
      .select('name')
      .eq('id', link.main_tree_id)
      .maybeSingle()
    let personId: string | undefined
    if (link.person_id) {
      const { data: person } = await supabase
        .from('persons')
        .select('code')
        .eq('id', link.person_id)
        .maybeSingle()
      personId = person?.code
    }
    return {
      mainTreeId: link.main_tree_id,
      mainTreeName: mainTree?.name ?? '',
      type: link.link_type,
      personId,
      personName: link.person_name ?? undefined,
      note: link.note ?? undefined,
    }
  } catch {
    return undefined
  }
}

const hydratedDbIdTrees = new Set<string>()

/**
 * The natural key of a person/union is (tree_id, code). A state restored from
 * an older local cache can be missing the cloud UUIDs (or carry UUIDs that were
 * generated before the row existed). Saving that state with fresh UUIDs trips
 * the (tree_id, code) unique constraint even though the upsert targets `id`.
 * Pull the canonical ids once per tree and stamp them onto the state before
 * building the bundle.
 */
async function hydrateDbIds(treeId: string, state: TreeState): Promise<void> {
  if (!state.root || hydratedDbIdTrees.has(treeId)) return
  try {
    const fetchIdCodes = async (table: 'persons' | 'unions') => {
      const rows: { id: string; code: string }[] = []
      const step = 1000
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from(table)
          .select('id,code')
          .eq('tree_id', treeId)
          .range(from, from + step - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        rows.push(...(data as { id: string; code: string }[]))
        if (data.length < step) break
        from += step
      }
      return rows
    }

    const [personRows, unionRows] = await Promise.all([
      fetchIdCodes('persons'),
      fetchIdCodes('unions'),
    ])

    const personIdByCode = new Map<string, string>()
    for (const row of personRows) {
      if (row?.code && row?.id) {
        personIdByCode.set(String(row.code).toUpperCase().trim(), row.id)
      }
    }
    const unionIdByCode = new Map<string, string>()
    for (const row of unionRows) {
      if (row?.code && row?.id) unionIdByCode.set(String(row.code), row.id)
    }

    const walk = (person: Person) => {
      const code = String(person.id ?? '').toUpperCase().trim()
      const existingPersonId = personIdByCode.get(code)
      if (existingPersonId) person.dbId = existingPersonId
      for (const wife of person.wives ?? []) {
        const existingUnionId = unionIdByCode.get(wife.id)
        if (existingUnionId) wife.dbId = existingUnionId
      }
      for (const child of person.children ?? []) walk(child)
    }
    walk(state.root)
    hydratedDbIdTrees.add(treeId)
  } catch {
    // Offline / transient failure: the save still runs and a later save retries.
  }
}

const RELATIONAL_PAGE_SIZE = 1000

interface ExistingPersonRow {
  id: string
  father_id: string | null
  sibling_order: number
}

interface ExistingUnionRow {
  id: string
  husband_id: string
}

async function fetchExistingPersonRows(treeId: string): Promise<ExistingPersonRow[] | null> {
  const rows: ExistingPersonRow[] = []
  for (let from = 0; ; from += RELATIONAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('persons')
      .select('id, father_id, sibling_order')
      .eq('tree_id', treeId)
      .order('id')
      .range(from, from + RELATIONAL_PAGE_SIZE - 1)
    if (error) {
      console.warn('[nasab] existing persons fetch:', error.message)
      return null
    }
    if (!data || data.length === 0) break
    rows.push(...(data as ExistingPersonRow[]))
    if (data.length < RELATIONAL_PAGE_SIZE) break
  }
  return rows
}

async function fetchExistingUnionRows(treeId: string): Promise<ExistingUnionRow[] | null> {
  const rows: ExistingUnionRow[] = []
  for (let from = 0; ; from += RELATIONAL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('unions')
      .select('id, husband_id')
      .eq('tree_id', treeId)
      .order('id')
      .range(from, from + RELATIONAL_PAGE_SIZE - 1)
    if (error) {
      console.warn('[nasab] existing unions fetch:', error.message)
      return null
    }
    if (!data || data.length === 0) break
    rows.push(...(data as ExistingUnionRow[]))
    if (data.length < RELATIONAL_PAGE_SIZE) break
  }
  return rows
}

function personOrderKey(fatherId: string | null | undefined, siblingOrder: number): string {
  return `${fatherId ?? ''}|${siblingOrder}`
}

/**
 * PostgreSQL checks persons_father_id_sibling_order_key row by row. A save that
 * deletes/renumbers siblings can therefore collide with rows that are about to
 * be deleted. Any bundle row whose final sibling slot is still owned by a
 * different existing row is staged at a temporary high order first.
 */
function conflictSiblingOrderOverrides(
  existing: ExistingPersonRow[],
  persons: RelationalTreeBundle['persons'],
): Map<string, number> {
  const existingByKey = new Map<string, ExistingPersonRow>()
  let maxOrder = 0
  for (const row of existing) {
    existingByKey.set(personOrderKey(row.father_id, row.sibling_order), row)
    maxOrder = Math.max(maxOrder, row.sibling_order ?? 0)
  }
  for (const person of persons) {
    maxOrder = Math.max(maxOrder, person.siblingOrder)
  }

  const overrides = new Map<string, number>()
  let nextTemp = maxOrder + 1
  for (const person of persons) {
    const owner = existingByKey.get(personOrderKey(person.fatherId, person.siblingOrder))
    if (owner && owner.id !== person.id) {
      overrides.set(person.id, nextTemp++)
    }
  }
  return overrides
}

async function upsertPersonRows(
  treeId: string,
  persons: RelationalTreeBundle['persons'],
  now: string,
  orderOverrides?: Map<string, number>,
  motherUnionOverrides?: Map<string, string | null>,
): Promise<boolean> {
  if (persons.length === 0) return true
  const rows = persons.map((p) => ({
    id: p.id,
    tree_id: treeId,
    code: p.code,
    name: p.name,
    gender: p.gender,
    father_id: p.fatherId ?? null,
    mother_union_id: motherUnionOverrides?.has(p.id)
      ? (motherUnionOverrides.get(p.id) ?? null)
      : (p.motherUnionId ?? null),
    sibling_order: orderOverrides?.get(p.id) ?? p.siblingOrder,
    branch_meta: p.branchMeta ?? null,
    updated_at: now,
  }))
  const { error } = await supabase.from('persons').upsert(rows, { onConflict: 'id' })
  if (error) {
    console.warn('[nasab] persons upsert:', error.message)
    return false
  }
  return true
}

async function upsertUnionRows(
  treeId: string,
  unions: RelationalTreeBundle['unions'],
  now: string,
): Promise<boolean> {
  if (unions.length === 0) return true
  const rows = unions.map((u) => ({
    id: u.id,
    tree_id: treeId,
    code: u.code,
    husband_id: u.husbandId,
    wife_person_id: u.wifePersonId ?? null,
    external_name: u.externalName ?? null,
    external_family: u.externalFamily ?? null,
    external_tribe: u.externalTribute ?? null,
    marriage_order: u.marriageOrder,
    legacy: u.legacy ?? null,
    updated_at: now,
  }))
  const { error } = await supabase.from('unions').upsert(rows, { onConflict: 'id' })
  if (error) {
    console.warn('[nasab] unions upsert:', error.message)
    return false
  }
  return true
}

/**
 * A mother link may point at a union this save is about to create. The person
 * upsert has to happen before the union exists, so those links are written as
 * NULL in the first phase and restored after the union insert.
 */
function getNewMotherUnionOverrides(
  bundle: RelationalTreeBundle,
  existingUnionIds: Set<string>,
): Map<string, string | null> {
  const bundleUnionIds = new Set(bundle.unions.map((u) => u.id))
  const overrides = new Map<string, string | null>()
  for (const person of bundle.persons) {
    if (
      person.motherUnionId &&
      !existingUnionIds.has(person.motherUnionId) &&
      bundleUnionIds.has(person.motherUnionId)
    ) {
      overrides.set(person.id, null)
    }
  }
  return overrides
}

async function upsertRelationalRows(
  treeId: string,
  bundle: RelationalTreeBundle,
  now: string,
  existingUnionIds: Set<string> = new Set(),
) {
  try {
    const newMotherUnionOverrides = getNewMotherUnionOverrides(bundle, existingUnionIds)
    if (newMotherUnionOverrides.size > 0) {
      if (!(await upsertPersonRows(treeId, bundle.persons, now, undefined, newMotherUnionOverrides))) {
        return false
      }
      if (!(await upsertUnionRows(treeId, bundle.unions, now))) return false
      if (!(await upsertPersonRows(treeId, bundle.persons, now))) return false
      return true
    }

    if (!(await upsertPersonRows(treeId, bundle.persons, now))) return false
    if (!(await upsertUnionRows(treeId, bundle.unions, now))) return false
    return true
  } catch (err) {
    console.warn('[nasab] upsertRelationalRows failed silently:', err)
    return false
  }
}

async function deleteMissingRows(
  treeId: string,
  nextPersonIds: string[],
  nextUnionIds: string[],
  removedUnionIds: string[] = [],
  existing?: { persons: ExistingPersonRow[]; unions: ExistingUnionRow[] },
) {
  try {
    const nextPersonSet = new Set(nextPersonIds)
    const nextUnionSet = new Set(nextUnionIds)
    const explicitRemovedUnionSet = new Set(removedUnionIds.filter(Boolean))
    const existingPersons = existing?.persons ?? (await fetchExistingPersonRows(treeId)) ?? []
    if (existingPersons.length > 0 && nextPersonIds.length === 0) {
      console.warn(`[nasab] Refusing to delete every person in tree ${treeId}; the save state looks incomplete.`)
    } else {
      const personIdsToDelete = existingPersons
        .map((r) => r.id)
        .filter((id) => !nextPersonSet.has(id))
      if (personIdsToDelete.length > 0) {
        const { error } = await supabase.from('persons').delete().in('id', personIdsToDelete)
        if (error) console.warn('[nasab] missing persons delete:', error.message)
      }
    }

    const existingUnions = existing?.unions ?? (await fetchExistingUnionRows(treeId)) ?? []
    if (
      existingUnions.length > 0 &&
      nextUnionIds.length === 0 &&
      explicitRemovedUnionSet.size === 0
    ) {
      // A partially loaded tree can look wife-less. Never let that wipe the
      // canonical union rows (and their cross-tree legacy metadata).
      console.warn(`[nasab] Refusing to delete every union in tree ${treeId}; the save state looks incomplete.`)
    } else {
      // Remove unions the editor explicitly deleted, plus unions whose husband
      // no longer exists. A save that merely failed to load some wives leaves
      // their husbands alive, so those unions are preserved.
      const unionIdsToDelete = existingUnions
        .filter(
          (r) =>
            !nextUnionSet.has(r.id) &&
            (explicitRemovedUnionSet.has(r.id) || !nextPersonSet.has(r.husband_id)),
        )
        .map((r) => r.id)
      if (unionIdsToDelete.length > 0) {
        const { error } = await supabase.from('unions').delete().in('id', unionIdsToDelete)
        if (error) console.warn('[nasab] missing unions delete:', error.message)
      }
    }
  } catch (err) {
    console.warn('[nasab] deleteMissingRows failed:', err)
  }
}

async function syncTreeLink(id: string, link: TreeLink | null) {
  try {
    await supabase.from('tree_links').delete().eq('branch_tree_id', id)
    if (!link) return

    let personUuid: string | null = null
    if (link.personId) {
      const { data } = await supabase
        .from('persons')
        .select('id')
        .eq('tree_id', link.mainTreeId)
        .eq('code', link.personId)
        .limit(1)
      personUuid = data?.[0]?.id ?? null
    }

    await supabase.from('tree_links').insert({
      main_tree_id: link.mainTreeId,
      branch_tree_id: id,
      link_type: link.type,
      person_id: personUuid,
      person_name: link.personName ?? null,
      note: link.note ?? null,
    })
  } catch (err) {
    console.warn('[nasab] syncTreeLink failed:', err)
  }
}

// Supabase CRUD with offline fallback
export async function fetchDeviceTrees(): Promise<TreeMeta[]> {
  const cached = getCachedTreeList()

  if (!navigator.onLine || !isConfigured) {
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
    const { data: trees, error } = await supabase
      .from('trees')
      .select('id, name, root_person_id, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50)

    if (error || !trees) return cached

    const ids = trees.map((t: any) => t.id)
    const rootIds = trees.map((t: any) => t.root_person_id).filter(Boolean)
    const { data: roots } = rootIds.length
      ? await supabase.from('persons').select('id, name').in('id', rootIds)
      : { data: [] as any[] }
    const rootNameMap = new Map((roots ?? []).map((r: any) => [r.id, r.name]))

    const { data: links } = await supabase
      .from('tree_links')
      .select('*')
      .in('branch_tree_id', ids)
    const linkRows = links ?? []
    const mainIds = [...new Set(linkRows.map((l: any) => l.main_tree_id))]
    const { data: mainTrees } = mainIds.length
      ? await supabase.from('trees').select('id, name').in('id', mainIds)
      : { data: [] as any[] }
    const mainNameMap = new Map((mainTrees ?? []).map((t: any) => [t.id, t.name]))

    const personIds = [...new Set(linkRows.map((l: any) => l.person_id).filter(Boolean))]
    const { data: linkPersons } = personIds.length
      ? await supabase.from('persons').select('id, code').in('id', personIds)
      : { data: [] as any[] }
    const personCodeMap = new Map((linkPersons ?? []).map((p: any) => [p.id, p.code]))

    const remoteTrees: TreeMeta[] = trees.map((t: any) => {
      const link = linkRows.find((l: any) => l.branch_tree_id === t.id)
      const linkedFrom = link
        ? {
            mainTreeId: link.main_tree_id,
            mainTreeName: mainNameMap.get(link.main_tree_id) ?? '',
            type: link.link_type,
            personId: link.person_id ? personCodeMap.get(link.person_id) : undefined,
            personName: link.person_name ?? undefined,
            note: link.note ?? undefined,
          }
        : undefined

      return {
        id: t.id,
        name: t.name,
        updated_at: t.updated_at,
        downloaded: Boolean(getCachedTreeList().find((c) => c.id === t.id)?.downloaded),
        synced: true,
        rootAncestor: rootNameMap.get(t.root_person_id) ?? t.name,
        linkedFrom,
      }
    })

    const localSessions = await getAllSessions().catch(() => [])
    const localMap = new Map(localSessions.map((s) => [s.id, s]))
    const mergedRemote = remoteTrees.map((t) => ({
      ...t,
      downloaded: Boolean(localMap.get(t.id)?.downloaded),
    }))

    const remoteIds = new Set(mergedRemote.map((t) => t.id))
    // Once the cloud list has loaded successfully, only keep local-only trees
    // that still have unsynced edits. Synced ghosts are trees deleted remotely.
    const localOnly = getCachedTreeList().filter((t) => {
      if (remoteIds.has(t.id)) return false
      const local = localMap.get(t.id)
      return t.synced === false || local?.synced === false
    })
    const merged = [...localOnly, ...mergedRemote]

    setCachedTreeList(merged)
    return merged
  } catch {
    return cached
  }
}

export async function fetchTreeState(id: string): Promise<TreeState | null> {
  const cached = getCachedState(id)
  const countWives = (root: TreeState['root']): number => {
    if (!root) return 0
    let total = 0
    const walk = (person: NonNullable<TreeState['root']>) => {
      total += (person.wives || []).length
      ;(person.children || []).forEach(walk)
    }
    walk(root)
    return total
  }

  if (!navigator.onLine || !isConfigured) {
    if (cached) return cached
    const local = await getSession(id)
    return local ? local.state : null
  }

  try {
    const { data: tree, error } = await supabase
      .from('trees')
      .select('id, name, root_person_id, version, updated_at')
      .eq('id', id)
      .maybeSingle()

    if (error || !tree) {
      if (cached) return cached
      const local = await getSession(id)
      return local ? local.state : null
    }

    const local = await getSession(id)
    const treeListCached = getCachedTreeList()
    const metaMatch = treeListCached.find((t) => t.id === id)

    const persons = await fetchPersons(id)
    const unions = await fetchUnions(id)
    const linkedFrom = await fetchLinkedFrom(id)

    const remoteTime = tree.updated_at ? new Date(tree.updated_at).getTime() : 0
    const localTime = local?.updated_at ? new Date(local.updated_at).getTime() : 0

    if (local && local.synced === false && localTime > remoteTime && local.state?.root) {
      // A local snapshot that lost its wives is corrupt/partial. The cloud copy
      // is canonical, so prefer it instead of letting the local state win.
      if (countWives(local.state.root) === 0 && unions.length > 0) {
        console.warn(
          `[nasab] Local state for tree ${id} has no wives but the cloud has ${unions.length} unions; preferring cloud.`,
        )
      } else {
        console.log(`[nasab] Local has newer unsynced edits for tree ${id}, keeping local`)
        return local.state
      }
    }

    const bundle: RelationalTreeBundle = {
      tree: {
        id: tree.id,
        name: tree.name,
        rootPersonId: tree.root_person_id,
        version: tree.version ?? 1,
        linkedFrom: linkedFrom ?? metaMatch?.linkedFrom,
        updated_at: tree.updated_at,
        synced: true,
      },
      persons,
      unions,
    }

    const state = relationalToTree(bundle)
    if (linkedFrom && !state.linkedFrom) state.linkedFrom = linkedFrom

    setCachedState(id, state)

    if (local?.downloaded) {
      await saveSessionLocally(
        {
          id,
          name: tree.name || local.name,
          state,
          updated_at: tree.updated_at || new Date().toISOString(),
          downloaded: true,
          synced: true,
          linkedFrom: linkedFrom ?? metaMatch?.linkedFrom,
        },
        true,
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
  state: TreeState,
  link?: TreeLink,
): Promise<string | null> {
  const treeId = crypto.randomUUID()
  const now = new Date().toISOString()
  const stateWithLink: TreeState = link ? { ...state, linkedFrom: link } : state
  const bundle = treeToRelational(treeId, name, stateWithLink, now)

  setCachedState(treeId, stateWithLink)
  await saveSessionLocally(
    {
      id: treeId,
      name,
      state: stateWithLink,
      updated_at: now,
      downloaded: true,
      synced: false,
      rootAncestor: state.root?.name || name,
      linkedFrom: link,
    },
    false,
    { bundle, skipCache: true },
  )

  const currentList = getCachedTreeList()
  const updatedList: TreeMeta[] = [
    { id: treeId, name, updated_at: now, downloaded: true, synced: false, linkedFrom: link },
    ...currentList.filter((t) => t.id !== treeId),
  ]
  setCachedTreeList(updatedList)

  if (!navigator.onLine || !isConfigured) {
    return treeId
  }

  try {
    const { error: treeError } = await supabase.from('trees').insert({
      id: treeId,
      name,
      root_person_id: bundle.tree.rootPersonId ?? null,
      version: 1,
      updated_at: now,
    })

    if (treeError) {
      console.warn('[nasab] createTree failed on Supabase:', treeError)
      return treeId
    }

    await upsertRelationalRows(treeId, bundle, now)

    if (link) {
      await syncTreeLink(treeId, link)
    }

    await saveSessionLocally(
      {
        id: treeId,
        name,
        state: stateWithLink,
        updated_at: now,
        downloaded: true,
        synced: true,
        rootAncestor: state.root?.name || name,
        linkedFrom: link,
      },
      true,
      { bundle, skipCache: true },
    )

    const finalTreeList = updatedList.map((t) =>
      t.id === treeId ? { ...t, synced: true } : t,
    )
    setCachedTreeList(finalTreeList)
    return treeId
  } catch {
    return treeId
  }
}

export interface SaveTreeOptions {
  /** Cloud ids the editor explicitly deleted; safe to remove before upsert. */
  removedPersonIds?: string[]
  /** Union ids the editor explicitly deleted; safe to remove even if the husband survives. */
  removedUnionIds?: string[]
}

export async function saveTreeState(
  id: string,
  state: TreeState,
  options: SaveTreeOptions = {},
): Promise<boolean> {
  const validation = validateTreeForSave(state.root)
  if (!validation.ok) {
    console.warn(
      `[nasab] Guard triggered: Refusing to save invalid tree ${id} (${validation.reason}).`,
    )
    return false
  }

  const now = new Date().toISOString()
  const name = state.root?.name ? `شجرة ${state.root.name}` : undefined

  const existing = await getSession(id)
  const cached = getCachedState(id)
  const effectiveLinkedFrom = state.linkedFrom || existing?.linkedFrom || existing?.state?.linkedFrom || cached?.linkedFrom
  const finalState: TreeState = effectiveLinkedFrom ? { ...state, linkedFrom: effectiveLinkedFrom } : state
  // A state restored from an older cache may lack the cloud UUIDs. Fill them in
  // before the local save mutates the state or the bundle generates new ones.
  if (isConfigured && navigator.onLine) {
    await hydrateDbIds(id, finalState)
  }
  const sessionName = name || existing?.name || 'شجرة'

  const saveName = name || existing?.name || sessionName
  let bundle = treeToRelational(id, saveName, finalState, now)

  setCachedState(id, finalState)

  await saveSessionLocally(
    {
      id,
      name: sessionName,
      state: finalState,
      updated_at: now,
      downloaded: true,
      synced: false,
      rootAncestor: finalState.root?.name || existing?.rootAncestor || sessionName,
      linkedFrom: effectiveLinkedFrom,
    },
    false,
    { bundle, skipCache: true },
  )

  const list = getCachedTreeList()
  const treeIndex = list.findIndex((t) => t.id === id)
  if (treeIndex !== -1) {
    list[treeIndex].updated_at = now
    if (name) list[treeIndex].name = name
    list[treeIndex].linkedFrom = effectiveLinkedFrom
    setCachedTreeList([...list])
  }

  if (!navigator.onLine || !isConfigured) return false

  const removedUnionIds = (options.removedUnionIds ?? []).filter(Boolean)
  const explicitRemovedUnionSet = new Set(removedUnionIds)

  try {
    // One paginated read gives us both the delete set and the sibling-slot
    // collisions. The previous 1,000-row default could miss rows on big trees.
    const [existingPersons, existingUnions] = await Promise.all([
      fetchExistingPersonRows(id),
      fetchExistingUnionRows(id),
    ])
    if (!existingPersons || !existingUnions) return false

    // The bundle was built once before the local save. A partially loaded
    // state can look wife-less; never let it overwrite the canonical unions
    // (this is what removed the wives previously). Explicit removals are
    // different: the editor really did delete those unions.
    if (
      bundle.unions.length === 0 &&
      existingUnions.length > 0 &&
      explicitRemovedUnionSet.size === 0
    ) {
      console.warn(
        `[nasab] Refusing to save tree ${id}: the save state has no wives but the cloud already has unions.`,
      )
      return false
    }

    const { data: current } = await supabase
      .from('trees')
      .select('version')
      .eq('id', id)
      .maybeSingle()
    const nextVersion = (current?.version ?? 0) + 1

    const { error } = await supabase
      .from('trees')
      .upsert(
        {
          id,
          name: saveName,
          root_person_id: finalState.root?.dbId ?? null,
          version: nextVersion,
          updated_at: now,
        },
        { onConflict: 'id' },
      )

    if (!error) {
      const existingUnionIds = new Set(existingUnions.map((union) => union.id))
      const writeBundle = async (nextBundle: RelationalTreeBundle): Promise<boolean> => {
        const overrides = conflictSiblingOrderOverrides(existingPersons, nextBundle.persons)
        if (overrides.size > 0) {
          // Stage conflicting rows at temporary high sibling orders, remove
          // the rows this save no longer contains, then write the final orders.
          // New mother unions must be staged as NULL too; otherwise the
          // mother-link trigger rejects the row before the union exists.
          const newMotherOverrides = getNewMotherUnionOverrides(nextBundle, existingUnionIds)
          const tempOk = await upsertPersonRows(
            id,
            nextBundle.persons,
            now,
            overrides,
            newMotherOverrides,
          )
          if (!tempOk) return false
          const nextPersonSet = new Set(nextBundle.persons.map((p) => p.id))
          const missingPersonIds = existingPersons
            .filter((row) => !nextPersonSet.has(row.id))
            .map((row) => row.id)
          if (missingPersonIds.length > 0) {
            const { error: deleteError } = await supabase
              .from('persons')
              .delete()
              .in('id', missingPersonIds)
            if (deleteError) {
              console.warn('[nasab] sibling staging delete:', deleteError.message)
              return false
            }
          }
        }
        return upsertRelationalRows(id, nextBundle, now, existingUnionIds)
      }

      let rowsOk = await writeBundle(bundle)
      if (!rowsOk) {
        // A stale state can still collide on (tree_id, code). Re-read the
        // canonical UUIDs and retry once so the save is never left half-done.
        hydratedDbIdTrees.delete(id)
        await hydrateDbIds(id, finalState)
        bundle = treeToRelational(id, saveName, finalState, now)
        rowsOk = await writeBundle(bundle)
      }
      if (!rowsOk) {
        hydratedDbIdTrees.delete(id)
        return false
      }
      // The bundle reflects any re-hydration, so the delete pass only removes
      // ids that were genuinely absent from this save. Explicitly removed
      // unions are removed even when the husband still exists (wife deletion).
      await deleteMissingRows(
        id,
        bundle.persons.map((p) => p.id),
        bundle.unions.map((u) => u.id),
        removedUnionIds,
        { persons: existingPersons, unions: existingUnions },
      )
      await syncTreeLink(id, effectiveLinkedFrom ?? null)

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
        true,
        { bundle, skipCache: true },
      )
      return true
    }
    return false
  } catch {
    // Will auto-sync via useSync
    return false
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
  if (navigator.onLine && isConfigured) {
    // Deleting a tree writes to tree_links + trees. Make sure the browser
    // really holds an editor session first; otherwise the request goes out as
    // `anon` and Postgres rejects it with "permission denied".
    await ensureEditorSession()

    const { error: linksError } = await supabase
      .from('tree_links')
      .delete()
      .or(`main_tree_id.eq.${id},branch_tree_id.eq.${id}`)
    if (linksError) throw new Error(linksError.message)

    const { error } = await supabase.from('trees').delete().eq('id', id)
    if (error) throw new Error(error.message)
  }

  const list = getCachedTreeList().filter((t) => t.id !== id)
  setCachedTreeList(list)
  localStorage.removeItem(CACHE_PREFIX + id)

  await deleteSessionLocally(id)
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
    await syncTreeLink(id, link)
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
      true,
    )
  } catch (err) {
    console.warn('[nasab] updateTreeLink failed:', err)
  }
}

