import { useCallback, useEffect, useRef, useState } from 'react'
import type { Gender, Person, TreeState } from './types'
import {
  advanceAfterDone,
  collectMalesDFS,
  findParent,
  findPerson,
  nextFemaleId,
  nextMaleId,
} from './treeUtils'
import {
  fetchTreeState,
  saveTreeState,
  getCachedState,
  setCachedState,
} from './db'

export const initialState: TreeState = {
  root: null,
  phase: 'setup',
  currentPersonId: null,
  maleCounter: 1,
  femaleCounter: 0,
  malesQueue: [],
  currentMaleIndex: 0,
}

function cloneRoot(root: Person): Person {
  return JSON.parse(JSON.stringify(root)) as Person
}

function isPerson(value: unknown): value is Person {
  if (!value || typeof value !== 'object') return false
  const person = value as Partial<Person>
  return (
    typeof person.id === 'string' &&
    /^[MF]\d{3,}$/.test(person.id) &&
    typeof person.name === 'string' &&
    (person.gender === 'M' || person.gender === 'F') &&
    person.id.startsWith(person.gender) &&
    Array.isArray(person.children) &&
    person.children.every(isPerson) &&
    Array.isArray(person.wives) &&
    person.wives.every((wife) => typeof wife === 'string')
  )
}

function countersFor(root: Person) {
  let highestMale = 0
  let highestFemale = 0

  function walk(person: Person) {
    const number = Number(person.id.slice(1))
    if (person.gender === 'M') highestMale = Math.max(highestMale, number)
    else highestFemale = Math.max(highestFemale, number)
    person.children.forEach(walk)
  }

  walk(root)
  return {
    maleCounter: highestMale + 1,
    femaleCounter: highestFemale,
  }
}

export function useTreeBuilder(treeId: string) {
  // Load from local cache immediately for instant UI, then sync from cloud
  const [state, setState] = useState<TreeState>(() => {
    return getCachedState(treeId) ?? initialState
  })
  const [isSyncing, setIsSyncing] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Prevent saving stale cache back to Supabase before the cloud fetch completes
  const hasLoadedRef = useRef(false)

  const [isOffline, setIsOffline] = useState(!navigator.onLine)

  // Track online/offline status and auto-sync when connection returns
  useEffect(() => {
    function handleOnline() {
      setIsOffline(false)
      if (hasLoadedRef.current) {
        void saveTreeState(treeId, state)
      }
    }
    function handleOffline() {
      setIsOffline(true)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [treeId, state])

  // ── Initial cloud fetch ──
  useEffect(() => {
    hasLoadedRef.current = false
    setIsSyncing(true)

    // Reset local state to cache (or empty) for the new treeId
    const cached = getCachedState(treeId)
    setState(cached ?? initialState)

    fetchTreeState(treeId)
      .then((cloudState) => {
        if (cloudState) {
          setState(cloudState)
          setCachedState(treeId, cloudState)
        }
      })
      .catch(() => {
        // Offline or error — keep using cache safely
      })
      .finally(() => {
        hasLoadedRef.current = true
        setIsSyncing(false)
      })
  }, [treeId])

  // ── Cache every state change locally (instant, synchronous) ──
  useEffect(() => {
    setCachedState(treeId, state)
  }, [state, treeId])

  // ── Debounced cloud save (only after initial fetch) ──
  useEffect(() => {
    if (!hasLoadedRef.current) return
    if (!navigator.onLine) return // Saved locally, skip cloud fetch until back online
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void saveTreeState(treeId, state)
    }, 600)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state, treeId])


  // ── Tree builder actions (unchanged from before) ──

  const startRoot = useCallback((name: string) => {
    const root: Person = {
      id: 'M001',
      name: name.trim(),
      gender: 'M',
      children: [],
      wives: [],
    }
    setState({
      ...initialState,
      root,
      phase: 'enter-children',
      currentPersonId: 'M001',
      maleCounter: 2,
    })
  }, [])

  const addChild = useCallback(
    (name: string, gender: Gender) => {
      if (!state.root || !state.currentPersonId || !name.trim()) return

      setState((prev) => {
        if (!prev.root || !prev.currentPersonId) return prev

        const root = cloneRoot(prev.root)
        const parent = findPerson(root, prev.currentPersonId)
        if (!parent) return prev

        const id =
          gender === 'M'
            ? nextMaleId(prev.maleCounter)
            : nextFemaleId(prev.femaleCounter + 1)

        parent.children.push({
          id,
          name: name.trim(),
          gender,
          children: [],
          wives: [],
        })

        return {
          ...prev,
          root,
          maleCounter: gender === 'M' ? prev.maleCounter + 1 : prev.maleCounter,
          femaleCounter:
            gender === 'F' ? prev.femaleCounter + 1 : prev.femaleCounter,
        }
      })
    },
    [state.root, state.currentPersonId],
  )

  function replaceChildren(
    prev: TreeState,
    personId: string,
    sonNames: string[],
    daughterNames: string[],
  ): TreeState {
    if (!prev.root) return prev

    const root = cloneRoot(prev.root)
    const parent = findPerson(root, personId)
    if (!parent) return prev

    const existingSons = parent.children.filter((child) => child.gender === 'M')
    const existingDaughters = parent.children.filter(
      (child) => child.gender === 'F',
    )
    let maleCounter = prev.maleCounter
    let femaleCounter = prev.femaleCounter

    function reconcile(
      names: string[],
      existingPeople: Person[],
      gender: Gender,
    ): Person[] {
      const unused = new Set(existingPeople)
      const matched = names.map((name) => {
        const exact = existingPeople.find(
          (person) => unused.has(person) && person.name === name,
        )
        if (exact) unused.delete(exact)
        return exact ?? null
      })

      // If only names changed, retain identity by position so descendants stay
      // attached to the same person. Exact-name matches above also make
      // inserting or reordering lines safe.
      if (names.length === existingPeople.length) {
        matched.forEach((person, index) => {
          if (person) return
          const replacement = existingPeople.find((item) => unused.has(item))
          if (replacement) {
            matched[index] = replacement
            unused.delete(replacement)
          }
        })
      }

      const result = names.map((name, index): Person => {
        const existing = matched[index]
        if (existing) return { ...existing, name }

        return {
          id:
            gender === 'M'
              ? nextMaleId(maleCounter++)
              : nextFemaleId(++femaleCounter),
          name,
          gender,
          children: [],
          wives: [],
        }
      })

      // Never silently delete a branch that was already transcribed.
      for (const person of unused) {
        if (person.children.length > 0) result.push(person)
      }
      return result
    }

    const sons = reconcile(sonNames, existingSons, 'M')
    const daughters = reconcile(daughterNames, existingDaughters, 'F')

    parent.children = [...sons, ...daughters]
    return { ...prev, root, maleCounter, femaleCounter }
  }

  const setChildren = useCallback(
    (personId: string, sonNames: string[], daughterNames: string[]) => {
      setState((prev) =>
        replaceChildren(prev, personId, sonNames, daughterNames),
      )
    },
    [],
  )

  const setChildrenAndContinue = useCallback(
    (sonNames: string[], daughterNames: string[]) => {
      setState((prev) => {
        if (!prev.root || !prev.currentPersonId) return prev

        const updated = replaceChildren(
          prev,
          prev.currentPersonId,
          sonNames,
          daughterNames,
        )
        if (!updated.root || !updated.currentPersonId) return updated

        const next = advanceAfterDone(updated.currentPersonId, updated.root)
        if (next === 'phase2') {
          const males = collectMalesDFS(updated.root)
          return {
            ...updated,
            phase: 'complete',
            currentPersonId: null,
            malesQueue: males.map((male) => male.id),
          }
        }

        return { ...updated, currentPersonId: next.id }
      })
    },
    [],
  )

  const renamePerson = useCallback((personId: string, name: string) => {
    const cleanName = name.trim()
    if (!cleanName) return

    setState((prev) => {
      if (!prev.root) return prev
      const root = cloneRoot(prev.root)
      const person = findPerson(root, personId)
      if (!person) return prev
      person.name = cleanName
      return { ...prev, root }
    })
  }, [])

  const deletePerson = useCallback((personId: string) => {
    setState((prev) => {
      if (!prev.root || prev.root.id === personId) return prev

      const root = cloneRoot(prev.root)
      const parent = findParent(root, personId)
      const target = findPerson(root, personId)
      if (!parent || !target) return prev

      parent.children = parent.children.filter((child) => child.id !== personId)
      const currentWasDeleted =
        !!prev.currentPersonId &&
        !!findPerson(target, prev.currentPersonId)
      const males = collectMalesDFS(root)
      return {
        ...prev,
        root,
        currentPersonId: currentWasDeleted ? parent.id : prev.currentPersonId,
        malesQueue: males.map((male) => male.id),
      }
    })
  }, [])

  /** Only the most recently added child of the current parent can be undone,
   * which keeps the global ID counters gap-free. */
  const undoLastChild = useCallback(() => {
    setState((prev) => {
      if (!prev.root || !prev.currentPersonId) return prev

      const root = cloneRoot(prev.root)
      const parent = findPerson(root, prev.currentPersonId)
      if (!parent || parent.children.length === 0) return prev

      const removed = parent.children.pop()!
      return {
        ...prev,
        root,
        maleCounter:
          removed.gender === 'M' ? prev.maleCounter - 1 : prev.maleCounter,
        femaleCounter:
          removed.gender === 'F' ? prev.femaleCounter - 1 : prev.femaleCounter,
      }
    })
  }, [])

  const finishChildren = useCallback(() => {
    if (!state.root || !state.currentPersonId) return

    const next = advanceAfterDone(state.currentPersonId, state.root)

    if (next === 'phase2') {
      const males = collectMalesDFS(state.root)
      setState((prev) => ({
        ...prev,
        phase: 'add-wives',
        currentPersonId: males[0]?.id ?? null,
        malesQueue: males.map((m) => m.id),
        currentMaleIndex: 0,
      }))
    } else {
      setState((prev) => ({
        ...prev,
        currentPersonId: next.id,
      }))
    }
  }, [state.root, state.currentPersonId])

  const addWifeToPerson = useCallback(
    (personId: string, name: string) => {
      const clean = name.trim()
      if (!clean) return

      setState((prev) => {
        if (!prev.root) return prev
        const root = cloneRoot(prev.root)
        const person = findPerson(root, personId)
        if (!person) return prev
        person.wives.push(clean)
        return { ...prev, root }
      })
    },
    [],
  )

  const removeWifeFromPerson = useCallback(
    (personId: string, index: number) => {
      setState((prev) => {
        if (!prev.root) return prev
        const root = cloneRoot(prev.root)
        const person = findPerson(root, personId)
        if (!person || index < 0 || index >= person.wives.length) return prev
        person.wives.splice(index, 1)
        return { ...prev, root }
      })
    },
    [],
  )

  const addWife = useCallback(
    (name: string) => {
      if (!state.root || !state.currentPersonId || !name.trim()) return
      addWifeToPerson(state.currentPersonId, name)
    },
    [state.root, state.currentPersonId, addWifeToPerson],
  )

  const removeWife = useCallback(
    (index: number) => {
      if (!state.root || !state.currentPersonId) return
      removeWifeFromPerson(state.currentPersonId, index)
    },
    [state.root, state.currentPersonId, removeWifeFromPerson],
  )


  const finishWives = useCallback(() => {
    setState((prev) => {
      const nextIndex = prev.currentMaleIndex + 1
      if (nextIndex >= prev.malesQueue.length) {
        return { ...prev, phase: 'complete', currentPersonId: null }
      }
      return {
        ...prev,
        currentMaleIndex: nextIndex,
        currentPersonId: prev.malesQueue[nextIndex],
      }
    })
  }, [])

  const exportProject = useCallback(() => {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        state,
      },
      null,
      2,
    )
  }, [state])

  const importProject = useCallback((value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false

    const container = value as { state?: Partial<TreeState> }
    const imported = (
      isPerson(value) ? { root: value } : (container.state ?? value)
    ) as Partial<TreeState>
    if (!isPerson(imported.root)) return false

    const counters = countersFor(imported.root)
    const males = collectMalesDFS(imported.root)
    const currentId =
      typeof imported.currentPersonId === 'string' &&
      findPerson(imported.root, imported.currentPersonId)
        ? imported.currentPersonId
        : imported.root.id

    setState({
      root: imported.root,
      phase: imported.phase === 'complete' ? 'complete' : 'enter-children',
      currentPersonId:
        imported.phase === 'complete' ? null : currentId,
      maleCounter: Math.max(imported.maleCounter ?? 0, counters.maleCounter),
      femaleCounter: Math.max(
        imported.femaleCounter ?? 0,
        counters.femaleCounter,
      ),
      malesQueue: Array.isArray(imported.malesQueue)
        ? imported.malesQueue
        : males.map((male) => male.id),
      currentMaleIndex:
        typeof imported.currentMaleIndex === 'number'
          ? imported.currentMaleIndex
          : 0,
    })
    return true
  }, [])

  const currentPerson =
    state.root && state.currentPersonId
      ? findPerson(state.root, state.currentPersonId)
      : null

  return {
    ...state,
    isSyncing,
    isOffline,
    currentPerson,
    startRoot,

    addChild,
    setChildren,
    setChildrenAndContinue,
    renamePerson,
    deletePerson,
    undoLastChild,
    finishChildren,
    addWife,
    removeWife,
    addWifeToPerson,
    removeWifeFromPerson,
    finishWives,
    exportProject,
    importProject,
  }
}

