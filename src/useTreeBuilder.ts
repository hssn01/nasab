import { useCallback, useEffect, useRef, useState } from 'react'
import type { Gender, Person, Phase, TreeState, Wife } from './types'
import {
  advanceAfterDone,
  collectMalesDFS,
  findParent,
  findPerson,
  findWifeByMotherKey,
  isWife,
  nextFemaleId,
  nextMaleId,
  normalizePersonTree,
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
  const motherOk =
    person.mother === undefined ||
    person.mother === null ||
    typeof person.mother === 'string' ||
    (typeof person.mother === 'object' && person.mother !== null)
  return (
    typeof person.id === 'string' &&
    /^[MF]\d{3,}$/.test(person.id) &&
    typeof person.name === 'string' &&
    (person.gender === 'M' || person.gender === 'F') &&
    person.id.startsWith(person.gender) &&
    Array.isArray(person.children) &&
    person.children.every(isPerson) &&
    Array.isArray(person.wives) &&
    person.wives.every(
      (wife) => typeof wife === 'string' || isWife(wife),
    ) &&
    motherOk
  )
}

function hydrateState(state: TreeState): TreeState {
  if (!state.root) return state
  return { ...state, root: normalizePersonTree(state.root) }
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
    const cached = getCachedState(treeId)
    return cached ? hydrateState(cached) : initialState
  })
  const [isSyncing, setIsSyncing] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Prevent saving stale cache back to Supabase before the cloud fetch completes
  const hasLoadedRef = useRef(false)

  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const stateRef = useRef(state)
  stateRef.current = state

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
    setState(cached ? hydrateState(cached) : initialState)

    fetchTreeState(treeId)
      .then((cloudState) => {
        if (cloudState) {
          const hydrated = hydrateState(cloudState)
          setState(hydrated)
          setCachedState(treeId, hydrated)
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

  // ── Debounced save (saves to IndexedDB and pushes to cloud if online) ──
  useEffect(() => {
    if (!hasLoadedRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void saveTreeState(treeId, state)
    }, 400)
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

  const addChildToPerson = useCallback(
    (parentId: string, name: string, gender: Gender): string | null => {
      const trimmed = name.trim()
      const current = stateRef.current
      if (!current.root || !parentId || !trimmed) return null

      const newId =
        gender === 'M'
          ? nextMaleId(current.maleCounter)
          : nextFemaleId(current.femaleCounter + 1)

      setState((prev) => {
        if (!prev.root) return prev
        const root = cloneRoot(prev.root)
        const parent = findPerson(root, parentId)
        if (!parent) return prev

        parent.children.push({
          id: newId,
          name: trimmed,
          gender,
          children: [],
          wives: [],
        })

        const males = collectMalesDFS(root)
        const malesQueue = males.map((m) => m.id)
        let currentMaleIndex = prev.currentMaleIndex
        if (prev.currentPersonId && malesQueue.includes(prev.currentPersonId)) {
          currentMaleIndex = malesQueue.indexOf(prev.currentPersonId)
        }

        return {
          ...prev,
          root,
          maleCounter: gender === 'M' ? prev.maleCounter + 1 : prev.maleCounter,
          femaleCounter:
            gender === 'F' ? prev.femaleCounter + 1 : prev.femaleCounter,
          malesQueue,
          currentMaleIndex,
        }
      })

      return newId
    },
    [],
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

    const males = collectMalesDFS(root)
    const malesQueue = males.map((m) => m.id)
    let currentMaleIndex = prev.currentMaleIndex
    if (prev.currentPersonId && malesQueue.includes(prev.currentPersonId)) {
      currentMaleIndex = malesQueue.indexOf(prev.currentPersonId)
    } else {
      currentMaleIndex = Math.min(currentMaleIndex, Math.max(0, malesQueue.length - 1))
    }

    return { ...prev, root, maleCounter, femaleCounter, malesQueue, currentMaleIndex }
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
          return beginWivesPhase(updated)
        }

        return { ...updated, currentPersonId: next.id }
      })
    },
    [],
  )

  function beginWivesPhase(prev: TreeState): TreeState {
    if (!prev.root) return { ...prev, phase: 'complete', currentPersonId: null }
    const males = collectMalesDFS(prev.root)
    if (males.length === 0) {
      return {
        ...prev,
        phase: 'complete',
        currentPersonId: null,
        malesQueue: [],
        currentMaleIndex: 0,
      }
    }
    return {
      ...prev,
      phase: 'add-wives',
      currentPersonId: males[0].id,
      malesQueue: males.map((male) => male.id),
      currentMaleIndex: 0,
    }
  }

  function replaceWives(
    prev: TreeState,
    personId: string,
    wives: Wife[],
  ): TreeState {
    if (!prev.root) return prev
    const root = cloneRoot(prev.root)
    const person = findPerson(root, personId)
    if (!person || person.gender !== 'M') return prev

    const oldWives = [...person.wives]
    person.wives = wives

    for (const child of person.children) {
      if (!child.mother) {
        if (wives.length === 1) child.mother = wives[0].id
        continue
      }

      const matchedOld = findWifeByMotherKey(
        { ...person, wives: oldWives },
        child.mother,
      )
      if (matchedOld) {
        const oldIndex = oldWives.findIndex((wife) => wife.id === matchedOld.id)
        if (oldIndex >= 0 && oldIndex < wives.length) {
          child.mother = wives[oldIndex].id
          continue
        }
      }

      const stillPresent = wives.some((wife) => wife.id === child.mother)
      if (!stillPresent) {
        child.mother = wives.length === 1 ? wives[0].id : null
      }
    }

    if (wives.length === 1) {
      for (const child of person.children) {
        if (!child.mother) child.mother = wives[0].id
      }
    }

    return { ...prev, root }
  }

  const setWives = useCallback((personId: string, wives: Wife[]) => {
    setState((prev) => replaceWives(prev, personId, wives))
  }, [])

  const setWivesAndContinue = useCallback((wives: Wife[]) => {
    setState((prev) => {
      if (!prev.root || !prev.currentPersonId) return prev
      const updated = replaceWives(prev, prev.currentPersonId, wives)
      const queueIndex = updated.malesQueue.indexOf(updated.currentPersonId!)
      const nextIndex =
        (queueIndex >= 0 ? queueIndex : updated.currentMaleIndex) + 1
      if (nextIndex >= updated.malesQueue.length) {
        return { ...updated, phase: 'complete', currentPersonId: null }
      }
      return {
        ...updated,
        currentMaleIndex: nextIndex,
        currentPersonId: updated.malesQueue[nextIndex],
      }
    })
  }, [])

  const setChildMother = useCallback(
    (childId: string, mother: string | null) => {
      setState((prev) => {
        if (!prev.root) return prev
        const root = cloneRoot(prev.root)
        const child = findPerson(root, childId)
        if (!child) return prev
        child.mother = mother?.trim() || null
        return { ...prev, root }
      })
    },
    [],
  )

  const setChildrenMothers = useCallback(
    (fatherId: string, assignments: Record<string, string | null>) => {
      setState((prev) => {
        if (!prev.root) return prev
        const root = cloneRoot(prev.root)
        const father = findPerson(root, fatherId)
        if (!father || father.gender !== 'M') return prev
        for (const child of father.children) {
          if (Object.prototype.hasOwnProperty.call(assignments, child.id)) {
            const value = assignments[child.id]
            child.mother = value?.trim() || null
          }
        }
        return { ...prev, root }
      })
    },
    [],
  )

  const startWivesPhase = useCallback(() => {
    setState((prev) => beginWivesPhase(prev))
  }, [])

  const goToPhase = useCallback((targetPhase: Phase) => {
    setState((prev) => {
      if (!prev.root) return prev
      if (targetPhase === 'enter-children') {
        return {
          ...prev,
          phase: 'enter-children',
          currentPersonId: prev.currentPersonId ?? prev.root.id,
        }
      }
      if (targetPhase === 'add-wives') {
        const males = collectMalesDFS(prev.root)
        const malesQueue = males.map((m) => m.id)
        if (malesQueue.length === 0) {
          return {
            ...prev,
            phase: 'complete',
            currentPersonId: null,
            malesQueue: [],
            currentMaleIndex: 0,
          }
        }
        let currentMaleIndex = prev.currentMaleIndex
        let currentPersonId = prev.currentPersonId
        if (!currentPersonId || !malesQueue.includes(currentPersonId)) {
          currentMaleIndex = Math.min(Math.max(0, currentMaleIndex), malesQueue.length - 1)
          currentPersonId = malesQueue[currentMaleIndex]
        } else {
          currentMaleIndex = malesQueue.indexOf(currentPersonId)
        }
        return {
          ...prev,
          phase: 'add-wives',
          currentPersonId,
          malesQueue,
          currentMaleIndex,
        }
      }
      if (targetPhase === 'complete') {
        return {
          ...prev,
          phase: 'complete',
          currentPersonId: null,
        }
      }
      return prev
    })
  }, [])

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
      const malesQueue = males.map((male) => male.id)

      if (prev.phase === 'add-wives') {
        let currentPersonId = prev.currentPersonId
        let currentMaleIndex = prev.currentMaleIndex

        if (
          currentWasDeleted ||
          !currentPersonId ||
          !malesQueue.includes(currentPersonId)
        ) {
          if (malesQueue.length === 0) {
            return {
              ...prev,
              root,
              phase: 'complete',
              currentPersonId: null,
              malesQueue,
              currentMaleIndex: 0,
            }
          }
          currentMaleIndex = Math.min(
            prev.currentMaleIndex,
            malesQueue.length - 1,
          )
          currentPersonId = malesQueue[currentMaleIndex]
        } else {
          currentMaleIndex = malesQueue.indexOf(currentPersonId)
        }

        return {
          ...prev,
          root,
          currentPersonId,
          malesQueue,
          currentMaleIndex,
        }
      }

      return {
        ...prev,
        root,
        currentPersonId: currentWasDeleted ? parent.id : prev.currentPersonId,
        malesQueue,
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
      setState((prev) => beginWivesPhase(prev))
    } else {
      setState((prev) => ({
        ...prev,
        currentPersonId: next.id,
      }))
    }
  }, [state.root, state.currentPersonId])

  const addWifeToPerson = useCallback((personId: string, wife: Wife) => {
    setState((prev) => {
      if (!prev.root) return prev
      const root = cloneRoot(prev.root)
      const person = findPerson(root, personId)
      if (!person || person.gender !== 'M') return prev

      if (wife.type === 'tree') {
        const alreadyLinked = person.wives.some(
          (existing) =>
            existing.type === 'tree' && existing.personId === wife.personId,
        )
        if (alreadyLinked) return prev
      }

      person.wives.push(wife)
      if (person.wives.length === 1) {
        for (const child of person.children) {
          if (!child.mother) child.mother = wife.id
        }
      }
      return { ...prev, root }
    })
  }, [])

  const removeWifeFromPerson = useCallback(
    (personId: string, index: number) => {
      setState((prev) => {
        if (!prev.root) return prev
        const root = cloneRoot(prev.root)
        const person = findPerson(root, personId)
        if (!person || index < 0 || index >= person.wives.length) return prev
        const [removed] = person.wives.splice(index, 1)
        for (const child of person.children) {
          if (child.mother === removed.id) {
            child.mother =
              person.wives.length === 1 ? person.wives[0].id : null
          }
        }
        return { ...prev, root }
      })
    },
    [],
  )

  const addWife = useCallback(
    (wife: Wife) => {
      if (!state.root || !state.currentPersonId) return
      addWifeToPerson(state.currentPersonId, wife)
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

    const root = normalizePersonTree(imported.root)
    const counters = countersFor(root)
    const males = collectMalesDFS(root)
    const currentId =
      typeof imported.currentPersonId === 'string' &&
      findPerson(root, imported.currentPersonId)
        ? imported.currentPersonId
        : root.id

    const phase =
      imported.phase === 'complete' ||
      imported.phase === 'add-wives' ||
      imported.phase === 'enter-children' ||
      imported.phase === 'setup'
        ? imported.phase
        : 'enter-children'

    const malesQueue = Array.isArray(imported.malesQueue)
      ? imported.malesQueue
      : males.map((male) => male.id)

    const currentMaleIndex =
      typeof imported.currentMaleIndex === 'number'
        ? imported.currentMaleIndex
        : 0

    setState({
      root,
      phase,
      currentPersonId:
        phase === 'complete'
          ? null
          : phase === 'add-wives'
            ? (malesQueue[currentMaleIndex] ?? males[0]?.id ?? null)
            : currentId,
      maleCounter: Math.max(imported.maleCounter ?? 0, counters.maleCounter),
      femaleCounter: Math.max(
        imported.femaleCounter ?? 0,
        counters.femaleCounter,
      ),
      malesQueue,
      currentMaleIndex,
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
    addChildToPerson,
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
    setWives,
    setWivesAndContinue,
    setChildMother,
    setChildrenMothers,
    startWivesPhase,
    goToPhase,
    finishWives,
    exportProject,
    importProject,
  }
}

