import type { SupabaseClient } from '@supabase/supabase-js'
import { relationalToTree, treeToRelational } from './relationalAdapter'
import type {
  DbPerson,
  Person,
  RelationalPerson,
  RelationalTreeBundle,
  RelationalUnion,
  Session,
  TreeLink,
} from './types'

const DB_NAME = 'nasab-offline-db'
const DB_VERSION = 2

type LocalStoreName = 'sessions' | 'persons' | 'unions'

interface LocalWrite {
  storeName: LocalStoreName
  value: unknown
}

export interface LocalDatabase {
  put<T>(storeName: LocalStoreName, value: T): Promise<void>
  putMany(entries: LocalWrite[]): Promise<void>
  get<T>(storeName: LocalStoreName, key: string): Promise<T | undefined>
  getAll<T>(storeName: 'sessions' | 'persons' | 'unions'): Promise<T[]>
  getAllByIndex<T>(
    storeName: 'sessions' | 'persons' | 'unions',
    indexName: string,
    query: IDBValidKey | IDBKeyRange,
  ): Promise<T[]>
  delete(storeName: 'sessions' | 'persons' | 'unions', key: string): Promise<void>
}

let dbPromise: Promise<IDBDatabase> | null = null

function openIndexedDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('sessions')) {
        const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' })
        sessionStore.createIndex('synced', 'synced', { unique: false })
        sessionStore.createIndex('downloaded', 'downloaded', { unique: false })
      }
      if (!db.objectStoreNames.contains('persons')) {
        const personStore = db.createObjectStore('persons', { keyPath: 'id' })
        personStore.createIndex('sessionId', 'sessionId', { unique: false })
        personStore.createIndex('treeId', 'treeId', { unique: false })
        personStore.createIndex('fatherId', 'fatherId', { unique: false })
        personStore.createIndex('synced', 'synced', { unique: false })
      } else {
        const personStore = request.transaction!.objectStore('persons')
        if (!personStore.indexNames.contains('treeId')) {
          personStore.createIndex('treeId', 'treeId', { unique: false })
        }
        if (!personStore.indexNames.contains('fatherId')) {
          personStore.createIndex('fatherId', 'fatherId', { unique: false })
        }
      }
      if (!db.objectStoreNames.contains('unions')) {
        const unionStore = db.createObjectStore('unions', { keyPath: 'id' })
        unionStore.createIndex('treeId', 'treeId', { unique: false })
        unionStore.createIndex('husbandId', 'husbandId', { unique: false })
        unionStore.createIndex('synced', 'synced', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return dbPromise
}

export async function getDb(): Promise<LocalDatabase> {
  const idb = await openIndexedDb()

  return {
    async put<T>(storeName: LocalStoreName, value: T): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.put(value)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
    },

    async putMany(entries: LocalWrite[]): Promise<void> {
      if (entries.length === 0) return
      return new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(['sessions', 'persons', 'unions'], 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
        for (const entry of entries) {
          tx.objectStore(entry.storeName).put(entry.value)
        }
      })
    },

    async get<T>(storeName: LocalStoreName, key: string): Promise<T | undefined> {
      return new Promise<T | undefined>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async getAll<T>(storeName: 'sessions' | 'persons' | 'unions'): Promise<T[]> {
      return new Promise<T[]>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.getAll()
        req.onsuccess = () => resolve((req.result as T[]) || [])
        req.onerror = () => reject(req.error)
      })
    },

    async getAllByIndex<T>(
      storeName: 'sessions' | 'persons' | 'unions',
      indexName: string,
      query: IDBValidKey | IDBKeyRange,
    ): Promise<T[]> {
      return new Promise<T[]>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const index = store.index(indexName)
        const req = index.getAll(query)
        req.onsuccess = () => resolve((req.result as T[]) || [])
        req.onerror = () => reject(req.error)
      })
    },

    async delete(storeName: 'sessions' | 'persons' | 'unions', key: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.delete(key)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
    },
  }
}

/**
 * Recursively extract persons from tree root for flat storage in IndexedDB
 */
export function extractPersons(root: Person | null, sessionId: string, updatedAt: string): DbPerson[] {
  if (!root) return []
  const result: DbPerson[] = []

  function walk(person: Person) {
    result.push({
      id: person.id,
      sessionId,
      name: person.name,
      gender: person.gender,
      children: person.children,
      wives: person.wives || [],
      mother: typeof person.mother === 'string' ? person.mother : null,
      updated_at: updatedAt,
      synced: true,
    })
    for (const child of person.children || []) {
      walk(child)
    }
  }

  walk(root)
  return result
}

/**
 * Direction 1: Download a full session from Supabase into IndexedDB
 */
export async function downloadSessionFromSupabase(
  sessionId: string,
  supabase: SupabaseClient
): Promise<void> {
  const { data: tree, error: treeErr } = await supabase
    .from('trees')
    .select('id, name, root_person_id, version, updated_at')
    .eq('id', sessionId)
    .maybeSingle()

  if (treeErr || !tree) {
    throw new Error(`Failed to fetch session: ${treeErr?.message || 'Not found'}`)
  }

  const persons = await fetchPersonsFromSupabase(supabase, sessionId)
  const unions = await fetchUnionsFromSupabase(supabase, sessionId)
  const linkedFrom = await fetchLinkedFromFromSupabase(supabase, sessionId)

  const bundle: RelationalTreeBundle = {
    tree: {
      id: tree.id,
      name: tree.name,
      rootPersonId: tree.root_person_id,
      version: tree.version ?? 1,
      linkedFrom,
      updated_at: tree.updated_at,
      synced: true,
    },
    persons,
    unions,
  }

  const state = relationalToTree(bundle)
  if (linkedFrom && !state.linkedFrom) state.linkedFrom = linkedFrom

  const db = await getDb()
  const existing = await db.get<Session>('sessions', sessionId)
  const rootAncestor = state.root?.name || existing?.rootAncestor || tree.name

  const localSession: Session = {
    id: tree.id,
    name: tree.name,
    state,
    updated_at: tree.updated_at,
    downloaded: true,
    synced: true,
    rootAncestor,
    linkedFrom,
  }

  const writes: LocalWrite[] = [{ storeName: 'sessions', value: localSession }]
  for (const p of persons) {
    writes.push({
      storeName: 'persons',
      value: { ...p, sessionId: tree.id, synced: true },
    })
  }
  for (const u of unions) {
    writes.push({ storeName: 'unions', value: { ...u, synced: true } })
  }
  await db.putMany(writes)

  try {
    localStorage.setItem(`nasab-cache-v1-${sessionId}`, JSON.stringify(state))
  } catch {
    // ignore
  }
}

async function fetchPersonsFromSupabase(supabase: SupabaseClient, treeId: string): Promise<RelationalPerson[]> {
  const { data, error } = await supabase.from('persons').select('*').eq('tree_id', treeId)
  if (error || !data) return []
  return data.map((p: any) => ({
    id: p.id,
    treeId: p.tree_id,
    code: p.code,
    name: p.name,
    gender: p.gender,
    fatherId: p.father_id ?? null,
    motherUnionId: p.mother_union_id ?? null,
    siblingOrder: p.sibling_order ?? 0,
    branchMeta: p.branch_meta ?? undefined,
    updated_at: p.updated_at,
    synced: true,
  }))
}

async function fetchUnionsFromSupabase(supabase: SupabaseClient, treeId: string): Promise<RelationalUnion[]> {
  const { data, error } = await supabase.from('unions').select('*').eq('tree_id', treeId)
  if (error || !data) return []
  return data.map((u: any) => ({
    id: u.id,
    treeId: u.tree_id,
    code: u.code,
    husbandId: u.husband_id,
    wifePersonId: u.wife_person_id ?? undefined,
    externalName: u.external_name ?? undefined,
    externalFamily: u.external_family ?? undefined,
    externalTribute: u.external_tribute ?? undefined,
    marriageOrder: u.marriage_order ?? 0,
    legacy: u.legacy ?? undefined,
    updated_at: u.updated_at,
    synced: true,
  }))
}

async function fetchLinkedFromFromSupabase(supabase: SupabaseClient, branchTreeId: string): Promise<TreeLink | undefined> {
  try {
    const { data: links } = await supabase.from('tree_links').select('*').eq('branch_tree_id', branchTreeId).limit(1)
    if (!links || links.length === 0) return undefined
    const link = links[0]
    const { data: mainTree } = await supabase.from('trees').select('name').eq('id', link.main_tree_id).maybeSingle()
    let personId: string | undefined
    if (link.person_id) {
      const { data: person } = await supabase.from('persons').select('code').eq('id', link.person_id).maybeSingle()
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

/**
 * Fetch all sessions from IndexedDB
 */
export async function getAllSessions(): Promise<Session[]> {
  const db = await getDb()
  return db.getAll<Session>('sessions')
}

/**
 * Fetch a single session by id from IndexedDB
 */
export async function getSession(id: string): Promise<Session | null> {
  const db = await getDb()
  const session = await db.get<Session>('sessions', id)
  return session || null
}

/**
 * Save or update session in IndexedDB (populates both session doc and relational stores)
 */
interface SaveSessionOptions {
  /** Reuse the relational bundle already built by the caller. */
  bundle?: RelationalTreeBundle
  /** Skip the localStorage mirror when the caller already wrote it. */
  skipCache?: boolean
}

export async function saveSessionLocally(
  session: Session,
  markSynced: boolean = false,
  options: SaveSessionOptions = {}
): Promise<void> {
  const db = await getDb()
  const existing = await db.get<Session>('sessions', session.id)

  const effectiveLink =
    session.linkedFrom ||
    session.state?.linkedFrom ||
    existing?.linkedFrom ||
    existing?.state?.linkedFrom

  const updatedState = session.state
    ? (effectiveLink ? { ...session.state, linkedFrom: effectiveLink } : session.state)
    : session.state

  const updatedSession: Session = {
    ...session,
    state: updatedState,
    downloaded: true,
    synced: markSynced,
    updated_at: session.updated_at || new Date().toISOString(),
    rootAncestor: session.state?.root?.name || existing?.rootAncestor || session.name,
    linkedFrom: effectiveLink,
  }
  const bundle =
    options.bundle ??
    (updatedSession.state
      ? treeToRelational(session.id, session.name, updatedSession.state, updatedSession.updated_at)
      : null)

  const writes: LocalWrite[] = [{ storeName: 'sessions', value: updatedSession }]
  if (bundle) {
    for (const p of bundle.persons) {
      writes.push({
        storeName: 'persons',
        value: { ...p, sessionId: session.id, synced: markSynced },
      })
    }
    for (const u of bundle.unions) {
      writes.push({
        storeName: 'unions',
        value: { ...u, synced: markSynced },
      })
    }
  }
  await db.putMany(writes)

  // Also update the localStorage mirror unless the caller already did.
  if (updatedSession.state && !options.skipCache) {
    try {
      localStorage.setItem(`nasab-cache-v1-${session.id}`, JSON.stringify(updatedSession.state))
    } catch {
      // ignore
    }
  }
}

/**
 * Save normalized relational tree directly to IndexedDB
 */
export async function saveRelationalTreeLocally(
  bundle: RelationalTreeBundle,
  markSynced: boolean = false
): Promise<void> {
  const db = await getDb()
  const treeState = relationalToTree(bundle)
  const session: Session = {
    id: bundle.tree.id,
    name: bundle.tree.name,
    state: treeState,
    updated_at: bundle.tree.updated_at,
    downloaded: true,
    synced: markSynced,
    rootAncestor: treeState.root?.name || bundle.tree.name,
    linkedFrom: bundle.tree.linkedFrom,
  }

  const writes: LocalWrite[] = [{ storeName: 'sessions', value: session }]
  for (const person of bundle.persons) {
    writes.push({
      storeName: 'persons',
      value: { ...person, sessionId: bundle.tree.id, synced: markSynced },
    })
  }
  for (const union of bundle.unions) {
    writes.push({
      storeName: 'unions',
      value: { ...union, synced: markSynced },
    })
  }
  await db.putMany(writes)

  try {
    localStorage.setItem(`nasab-cache-v1-${bundle.tree.id}`, JSON.stringify(treeState))
  } catch {
    // ignore
  }
}

/**
 * Load normalized relational tree from IndexedDB
 */
export async function getRelationalTreeLocally(
  treeId: string
): Promise<RelationalTreeBundle | null> {
  const db = await getDb()
  const session = await db.get<Session>('sessions', treeId)
  if (!session) return null

  const persons = await db.getAllByIndex<RelationalPerson>('persons', 'treeId', treeId)
  const unions = await db.getAllByIndex<RelationalUnion>('unions', 'treeId', treeId)

  // If persons or unions not populated in relational format yet, extract from session.state
  if (persons.length === 0 && session.state) {
    return treeToRelational(session.id, session.name, session.state, session.updated_at)
  }

  const relTree = {
    id: session.id,
    name: session.name,
    rootPersonId: session.state?.root?.id || null,
    version: 1,
    linkedFrom: session.linkedFrom,
    updated_at: session.updated_at,
    synced: session.synced,
  }

  return {
    tree: relTree,
    persons,
    unions,
  }
}

/**
 * Delete a session and its associated persons and unions from IndexedDB
 */
export async function deleteSessionLocally(sessionId: string): Promise<void> {
  const db = await getDb()
  await db.delete('sessions', sessionId)

  // Clean up relational persons and unions
  try {
    const persons = await db.getAllByIndex<RelationalPerson>('persons', 'treeId', sessionId)
    for (const p of persons) {
      await db.delete('persons', p.id)
    }
    const unions = await db.getAllByIndex<RelationalUnion>('unions', 'treeId', sessionId)
    for (const u of unions) {
      await db.delete('unions', u.id)
    }
  } catch {
    // ignore
  }

  // Remove local cache
  try {
    localStorage.removeItem(`nasab-cache-v1-${sessionId}`)
  } catch {
    // ignore
  }
}

/**
 * Get all sessions marked synced: false
 */
export async function getUnsyncedSessions(): Promise<Session[]> {
  const all = await getAllSessions()
  return all.filter((s) => s.synced === false)
}

/**
 * Mark session as synced: true in IndexedDB
 */
export async function markSessionSynced(sessionId: string): Promise<void> {
  const db = await getDb()
  const session = await db.get<Session>('sessions', sessionId)
  if (session) {
    await db.put('sessions', { ...session, synced: true })
  }
}

const LOCAL_MIGRATION_KEY = 'nasab-relational-migration-v1'

/**
 * One-time batch migration: converts all existing local sessions' JSON state
 * into normalized relational records (persons + unions) in IndexedDB.
 * Safe to call on every app start — it only runs once.
 */
export async function migrateAllLocalSessions(): Promise<void> {
  // Skip if already migrated
  if (localStorage.getItem(LOCAL_MIGRATION_KEY) === 'done') return

  try {
    const db = await getDb()
    const sessions = await db.getAll<Session>('sessions')
    let migrated = 0

    for (const session of sessions) {
      if (!session.state?.root) continue

      // Check if this session already has relational persons
      const existingPersons = await db.getAllByIndex<RelationalPerson>(
        'persons', 'treeId', session.id
      )
      if (existingPersons.length > 0) continue

      // Convert JSON tree → relational records
      const bundle = treeToRelational(
        session.id,
        session.name,
        session.state,
        session.updated_at
      )

      const writes: LocalWrite[] = bundle.persons.map((p) => ({
        storeName: 'persons',
        value: { ...p, sessionId: session.id, synced: session.synced ?? true },
      }))
      for (const u of bundle.unions) {
        writes.push({
          storeName: 'unions',
          value: { ...u, synced: session.synced ?? true },
        })
      }
      await db.putMany(writes)

      migrated++
    }

    localStorage.setItem(LOCAL_MIGRATION_KEY, 'done')

    if (migrated > 0) {
      console.log(`[nasab] Migrated ${migrated} local trees to relational format`)
    }
  } catch (err) {
    console.warn('[nasab] Local relational migration failed, will retry next load:', err)
    // Don't set the flag so it retries on next app start
  }
}
