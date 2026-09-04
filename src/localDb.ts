import type { SupabaseClient } from '@supabase/supabase-js'
import type { DbPerson, Person, Session, TreeState } from './types'

const DB_NAME = 'nasab-offline-db'
const DB_VERSION = 1

export interface LocalDatabase {
  put<T>(storeName: 'sessions' | 'persons', value: T): Promise<void>
  get<T>(storeName: 'sessions' | 'persons', key: string): Promise<T | undefined>
  getAll<T>(storeName: 'sessions' | 'persons'): Promise<T[]>
  delete(storeName: 'sessions' | 'persons', key: string): Promise<void>
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
        personStore.createIndex('synced', 'synced', { unique: false })
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
    async put<T>(storeName: 'sessions' | 'persons', value: T): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readwrite')
        const store = tx.objectStore(storeName)
        const req = store.put(value)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
      })
    },

    async get<T>(storeName: 'sessions' | 'persons', key: string): Promise<T | undefined> {
      return new Promise<T | undefined>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.get(key)
        req.onsuccess = () => resolve(req.result as T | undefined)
        req.onerror = () => reject(req.error)
      })
    },

    async getAll<T>(storeName: 'sessions' | 'persons'): Promise<T[]> {
      return new Promise<T[]>((resolve, reject) => {
        const tx = idb.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const req = store.getAll()
        req.onsuccess = () => resolve((req.result as T[]) || [])
        req.onerror = () => reject(req.error)
      })
    },

    async delete(storeName: 'sessions' | 'persons', key: string): Promise<void> {
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
  // First try fetching from 'sessions' table, fallback to 'trees' table
  let sessionData: { id: string; name: string; state?: TreeState; updated_at: string } | null = null

  const { data: tree, error: tErr } = await supabase
    .from('trees')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (!tErr && tree) {
    sessionData = tree
  } else {
    const { data: sess, error: sErr } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single()

    if (sErr || !sess) {
      throw new Error(`Failed to fetch session: ${tErr?.message || sErr?.message || 'Not found'}`)
    }
    sessionData = sess
  }

  if (!sessionData) {
    throw new Error('Failed to fetch session data')
  }

  // Fetch persons if a persons table exists, otherwise extract from state.root
  let persons: DbPerson[] = []
  const { data: fetchedPersons, error: pErr } = await supabase
    .from('persons')
    .select('*')
    .eq('sessionId', sessionId)

  if (!pErr && fetchedPersons && fetchedPersons.length > 0) {
    persons = fetchedPersons
  } else if (sessionData.state?.root) {
    persons = extractPersons(sessionData.state.root, sessionId, sessionData.updated_at)
  }

  // Save to IndexedDB — mark as synced & downloaded (clean copy from server)
  const db = await getDb()
  const rootAncestor = sessionData.state?.root?.name || sessionData.name

  const localSession: Session = {
    id: sessionData.id,
    name: sessionData.name,
    state: sessionData.state || ({
      root: null,
      phase: 'setup',
      currentPersonId: null,
      maleCounter: 1,
      femaleCounter: 0,
      malesQueue: [],
      currentMaleIndex: 0,
    } as TreeState),
    updated_at: sessionData.updated_at,
    downloaded: true,
    synced: true,
    rootAncestor,
  }

  await db.put('sessions', localSession)

  for (const person of persons) {
    await db.put('persons', { ...person, sessionId, synced: true })
  }

  // Also sync with localStorage cache for backwards compatibility
  try {
    localStorage.setItem(`nasab-cache-v1-${sessionId}`, JSON.stringify(localSession.state))
  } catch {
    // ignore
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
 * Save or update session in IndexedDB
 */
export async function saveSessionLocally(
  session: Session,
  markSynced: boolean = false
): Promise<void> {
  const db = await getDb()
  const updatedSession: Session = {
    ...session,
    downloaded: true,
    synced: markSynced,
    updated_at: session.updated_at || new Date().toISOString(),
    rootAncestor: session.state?.root?.name || session.name,
  }
  await db.put('sessions', updatedSession)

  // Also save extracted persons
  if (session.state?.root) {
    const persons = extractPersons(session.state.root, session.id, updatedSession.updated_at)
    for (const p of persons) {
      await db.put('persons', { ...p, synced: markSynced })
    }
  }

  // Also update local cache
  try {
    localStorage.setItem(`nasab-cache-v1-${session.id}`, JSON.stringify(session.state))
  } catch {
    // ignore
  }
}

/**
 * Delete a session and its associated persons from IndexedDB
 */
export async function deleteSessionLocally(sessionId: string): Promise<void> {
  const db = await getDb()
  await db.delete('sessions', sessionId)

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
