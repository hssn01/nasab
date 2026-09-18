import { useEffect, useMemo, useRef, useState } from 'react'
import type { Person, TreeMeta, TreeState } from '../types'
import {
  buildUnifiedTree,
  type ConnectedBranchInput,
  type UnifiedTreeResult,
} from '../treeUtils'
import { fetchTreeState, getCachedState } from '../db'
import { getSession } from '../localDb'

interface UseUnifiedTreeOptions {
  mainTreeId: string | null
  mainRoot: Person | null
  mainTreeName: string
  sessions: TreeMeta[]
  enabled?: boolean
}

interface UseUnifiedTreeReturn {
  unifiedResult: UnifiedTreeResult | null
  isLoading: boolean
  branchCount: number
  hasConnectedBranches: boolean
}

async function loadBranchState(id: string): Promise<TreeState | null> {
  const cached = getCachedState(id)
  if (cached) return cached
  const local = await getSession(id)
  if (local?.state) return local.state
  return fetchTreeState(id)
}

export function useUnifiedTree({
  mainTreeId,
  mainRoot,
  mainTreeName,
  sessions,
  enabled = true,
}: UseUnifiedTreeOptions): UseUnifiedTreeReturn {
  const [unifiedResult, setUnifiedResult] = useState<UnifiedTreeResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Memoize to prevent new array reference on every render
  const connectedBranchMetas = useMemo(
    () => sessions.filter((s) => s.linkedFrom?.mainTreeId === mainTreeId),
    // Use JSON-serialized IDs as stable key so the memo only changes when the
    // actual set of branch IDs changes, not on every session object re-creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      mainTreeId,
      // Derive a stable primitive from the branch list
      sessions
        .filter((s) => s.linkedFrom?.mainTreeId === mainTreeId)
        .map((s) => s.id)
        .sort()
        .join(','),
    ]
  )

  const hasConnectedBranches = connectedBranchMetas.length > 0

  // Use a ref to track whether a build is already in-flight so we don't stack
  const buildInFlight = useRef(false)

  // Stable string key so the effect only re-runs when tree IDs actually change
  const branchIdsKey = useMemo(
    () => connectedBranchMetas.map((m) => m.id).sort().join(','),
    [connectedBranchMetas]
  )

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
      return
    }

    if (buildInFlight.current) return
    buildInFlight.current = true
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
        const branches: ConnectedBranchInput[] = results.filter((b): b is ConnectedBranchInput => b !== null)
        const result = buildUnifiedTree(idSnapshot, rootSnapshot, nameSnapshot, branches)
        setUnifiedResult(result)
      })
      .catch((err) => {
        console.error('[useUnifiedTree] Failed to load branch states:', err)
        setUnifiedResult({
          root: rootSnapshot,
          branchCount: 0,
          connectedTreeIds: [idSnapshot],
          isUnified: false,
        })
      })
      .finally(() => {
        setIsLoading(false)
        buildInFlight.current = false
      })
    // Re-run when tree IDs change, unified toggled, or mainRoot is loaded / changed
  }, [mainTreeId, branchIdsKey, enabled, mainRoot?.id, mainRoot?.name, mainRoot?.children?.length])

  return {
    unifiedResult,
    isLoading,
    branchCount: connectedBranchMetas.length,
    hasConnectedBranches,
  }
}
