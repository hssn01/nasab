import type {
  ExternalWife,
  Person,
  RelationalPerson,
  RelationalTree,
  RelationalTreeBundle,
  RelationalUnion,
  TreeState,
  TreeWife,
  Wife,
} from './types'

/**
 * Converts a hierarchical TreeState into a normalized RelationalTreeBundle (trees, persons, unions)
 */
export function treeToRelational(
  treeId: string,
  treeName: string,
  state: TreeState,
  updatedAt: string = new Date().toISOString(),
): RelationalTreeBundle {
  const persons: RelationalPerson[] = []
  const unions: RelationalUnion[] = []

  function walk(
    node: Person,
    fatherId: string | null,
    birthOrder: number,
  ) {
    const husbandWives = node.wives || []
    const husbandWifeIds = new Set(husbandWives.map((w) => w.id))

    // Extract unions for this person (if male and has wives)
    if (node.gender === 'M' && husbandWives.length > 0) {
      husbandWives.forEach((wife, idx) => {
        const union: RelationalUnion = {
          id: wife.id || `u-${node.id}-${idx}`,
          treeId,
          husbandId: node.id,
          type: wife.type,
          marriageOrder: idx,
          updated_at: updatedAt,
          synced: true,
        }

        if (wife.type === 'tree') {
          union.wifePersonId = wife.personId
          union.wifeTreeId = wife.treeId
          union.wifeTreeName = wife.treeName
          union.wifePersonName = wife.personName
          union.wifeLineageLabel = wife.lineageLabel
        } else {
          union.externalName = wife.name
          union.externalFamily = wife.family
          union.externalTribute = wife.tribute
        }

        unions.push(union)
      })
    }

    // Determine motherId and unionId
    let motherId: string | null = null
    let unionId: string | null = null

    if (node.mother) {
      motherId = node.mother.trim() || null
      if (motherId && husbandWifeIds.has(motherId)) {
        unionId = motherId
      }
    }

    const relPerson: RelationalPerson = {
      id: node.id,
      treeId,
      name: node.name,
      gender: node.gender,
      fatherId,
      motherId,
      unionId,
      birthOrder,
      branchMeta: node.branchMeta,
      updated_at: updatedAt,
      synced: true,
    }

    persons.push(relPerson)

    // Recurse children preserving birth order
    const children = node.children || []
    children.forEach((child, idx) => {
      walk(child, node.id, idx)
    })
  }

  if (state.root) {
    walk(state.root, null, 0)
  }

  const relTree: RelationalTree = {
    id: treeId,
    name: treeName,
    rootPersonId: state.root ? state.root.id : null,
    phase: state.phase,
    currentPersonId: state.currentPersonId,
    maleCounter: state.maleCounter,
    femaleCounter: state.femaleCounter,
    malesQueue: state.malesQueue,
    currentMaleIndex: state.currentMaleIndex,
    linkedFrom: state.linkedFrom,
    updated_at: updatedAt,
    synced: true,
  }

  return {
    tree: relTree,
    persons,
    unions,
  }
}

/**
 * Reconstructs a full hierarchical TreeState from a normalized RelationalTreeBundle
 */
export function relationalToTree(bundle: RelationalTreeBundle): TreeState {
  const { tree, persons, unions } = bundle

  if (persons.length === 0) {
    return {
      root: null,
      phase: tree.phase || 'setup',
      currentPersonId: null,
      maleCounter: tree.maleCounter || 1,
      femaleCounter: tree.femaleCounter || 0,
      malesQueue: tree.malesQueue || [],
      currentMaleIndex: tree.currentMaleIndex || 0,
      linkedFrom: tree.linkedFrom,
    }
  }

  // 1. Group unions by husbandId
  const unionsByHusband = new Map<string, RelationalUnion[]>()
  for (const u of unions) {
    const list = unionsByHusband.get(u.husbandId) || []
    list.push(u)
    unionsByHusband.set(u.husbandId, list)
  }

  // 2. Build Person objects map
  const personMap = new Map<string, Person>()
  for (const p of persons) {
    // Map unions back to Wife array
    const husbandUnions = (unionsByHusband.get(p.id) || []).sort(
      (a, b) => (a.marriageOrder ?? 0) - (b.marriageOrder ?? 0),
    )

    const wives: Wife[] = husbandUnions.map((u) => {
      if (u.type === 'tree') {
        const treeWife: TreeWife = {
          id: u.id,
          type: 'tree',
          personId: u.wifePersonId || '',
          treeId: u.wifeTreeId,
          treeName: u.wifeTreeName,
          personName: u.wifePersonName,
          lineageLabel: u.wifeLineageLabel,
        }
        return treeWife
      }
      const extWife: ExternalWife = {
        id: u.id,
        type: 'external',
        name: u.externalName || '',
        family: u.externalFamily || '',
        tribute: u.externalTribute || '',
      }
      return extWife
    })

    const personNode: Person = {
      id: p.id,
      name: p.name,
      gender: p.gender,
      children: [],
      wives,
      mother: p.motherId ?? undefined,
      branchMeta: p.branchMeta,
    }

    personMap.set(p.id, personNode)
  }

  // 3. Connect parent -> children preserving birth order
  const sortedPersons = [...persons].sort((a, b) => a.birthOrder - b.birthOrder)
  let rootNode: Person | null = null

  // Find explicit root or fallback to person without fatherId
  const rootId = tree.rootPersonId || sortedPersons.find((p) => !p.fatherId)?.id

  for (const p of sortedPersons) {
    const node = personMap.get(p.id)
    if (!node) continue

    if (p.fatherId && personMap.has(p.fatherId)) {
      const fatherNode = personMap.get(p.fatherId)!
      fatherNode.children.push(node)
    } else if (p.id === rootId || !rootNode) {
      rootNode = node
    }
  }

  if (!rootNode && sortedPersons.length > 0) {
    rootNode = personMap.get(sortedPersons[0].id) || null
  }

  return {
    root: rootNode,
    phase: tree.phase,
    currentPersonId: tree.currentPersonId,
    maleCounter: tree.maleCounter,
    femaleCounter: tree.femaleCounter,
    malesQueue: tree.malesQueue,
    currentMaleIndex: tree.currentMaleIndex,
    linkedFrom: tree.linkedFrom,
  }
}
