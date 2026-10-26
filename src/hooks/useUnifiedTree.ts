import { useEffect, useMemo, useRef, useState } from 'react'
import type { Person, TreeMeta, TreeState } from '../types'
import {
  buildUnifiedTree,
  type ConnectedBranchInput,
  type UnifiedTreeResult,
} from '../treeUtils'
import { fetchTreeState } from '../db'

interface UseUnifiedTreeOptions {
  mainTreeId: string | null
  mainRoot: Person | null
  mainTreeName: string
  sessions: TreeMeta[]
  enabled?: boolean
  commonFatherName?: string
}

interface UseUnifiedTreeReturn {
  unifiedResult: UnifiedTreeResult | null
  isLoading: boolean
  branchCount: number
  hasConnectedBranches: boolean
}

async function loadBranchState(id: string): Promise<TreeState | null> {
  // Always try the cloud copy first. A stale branch cache used to shadow a
  // repaired cloud tree for the whole session, so a branch could keep showing
  // missing wives even after the database was fixed. fetchTreeState already
  // falls back to the cache/offline state when the network is unavailable.
  return fetchTreeState(id)
}

export function useUnifiedTree({
  mainTreeId,
  mainRoot,
  mainTreeName,
  sessions,
  enabled = true,
  commonFatherName,
}: UseUnifiedTreeOptions): UseUnifiedTreeReturn {
  const [unifiedResult, setUnifiedResult] = useState<UnifiedTreeResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const branchIds = sessions
    .filter((s) => s.id !== mainTreeId && s.linkedFrom?.mainTreeId === mainTreeId)
    .map((s) => s.id)
    .sort()
    .join(',')

  // Memoize to prevent a new array reference on every render.
  const connectedBranchMetas = useMemo(
    () => sessions.filter((s) => s.id !== mainTreeId && s.linkedFrom?.mainTreeId === mainTreeId),
    [sessions, mainTreeId],
  )

  const hasConnectedBranches = connectedBranchMetas.length > 0

  // Revision counter: each edit increments this so in-flight async builds
  // for an older revision are discarded rather than overwriting fresh state.
  const revisionRef = useRef(0)

  // Cache loaded branch states so we don't re-fetch from Supabase on every
  // local edit — branches only reload when their IDs change.
  const cachedBranchesRef = useRef<ConnectedBranchInput[] | null>(null)
  const cachedBranchIdsRef = useRef<string>('')

  // Stable string key so the async branch-load only re-runs when tree IDs change.
  const branchIdsKey = branchIds

  // ── When there are NO connected branches, update synchronously from mainRoot.
  // This is the most common case during editing and must be instant.
  useEffect(() => {
    if (!mainRoot || !mainTreeId || !enabled) {
      setUnifiedResult(null)
      return
    }
    if (connectedBranchMetas.length === 0) {
      setUnifiedResult({
        root: mainRoot,
        branchCount: 0,
        connectedTreeIds: [mainTreeId],
        isUnified: false,
      })
    }
  // Re-run any time mainRoot reference changes (every edit produces a new object via cloneRoot)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainRoot, mainTreeId, enabled, connectedBranchMetas.length])

  // ── When there ARE connected branches, load them once (per branchIdsKey),
  // then rebuild the unified tree synchronously whenever mainRoot changes.
  useEffect(() => {
    if (!mainRoot || !mainTreeId || !enabled || connectedBranchMetas.length === 0) return

    const currentRevision = ++revisionRef.current

    // If branch IDs haven't changed, reuse the cached branches. Debounce the
    // rebuild so typing in the chart does not clone the whole tree per keystroke.
    if (cachedBranchesRef.current && cachedBranchIdsRef.current === branchIdsKey) {
      const cachedBranches = cachedBranchesRef.current
      const timer = setTimeout(() => {
        const result = buildUnifiedTree(
          mainTreeId,
          mainRoot,
          mainTreeName,
          cachedBranches,
          commonFatherName
        )
        setUnifiedResult(result)
      }, 150)
      return () => clearTimeout(timer)
    }

    // Branch IDs changed — fetch from cloud then rebuild.
    setIsLoading(true)

    const metasSnapshot = [...connectedBranchMetas]
    const rootSnapshot = mainRoot
    const idSnapshot = mainTreeId
    const nameSnapshot = mainTreeName

    Promise.all(
      metasSnapshot.map(async (meta) => {
        const state = await loadBranchState(meta.id)
        if (state?.root) {
          const branch: ConnectedBranchInput = {
            id: meta.id,
            name: meta.name,
            state,
            linkedFrom: meta.linkedFrom,
          }
          return branch
        }
        return null
      })
    )
      .then((results) => {
        // Discard stale results from a superseded async call
        if (revisionRef.current !== currentRevision) return

        const branches: ConnectedBranchInput[] = results.filter((b): b is ConnectedBranchInput => b !== null)
        // Cache for instant rebuilds on subsequent local edits
        cachedBranchesRef.current = branches
        cachedBranchIdsRef.current = branchIdsKey

        const result = buildUnifiedTree(idSnapshot, rootSnapshot, nameSnapshot, branches, commonFatherName)
        setUnifiedResult(result)
      })
      .catch((err) => {
        if (revisionRef.current !== currentRevision) return
        console.error('[useUnifiedTree] Failed to load branch states:', err)
        setUnifiedResult({
          root: rootSnapshot,
          branchCount: 0,
          connectedTreeIds: [idSnapshot],
          isUnified: false,
        })
      })
      .finally(() => {
        if (revisionRef.current === currentRevision) setIsLoading(false)
      })
  // mainRoot reference changes on every local edit — this is intentional so
  // the unified view reflects edits immediately using the cached branches.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainRoot, mainTreeId, branchIdsKey, enabled, commonFatherName, mainTreeName])

  return {
    unifiedResult,
    isLoading,
    branchCount: connectedBranchMetas.length,
    hasConnectedBranches,
  }
}
