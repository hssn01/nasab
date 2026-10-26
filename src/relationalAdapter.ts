import type {
  ExternalWife,
  Person,
  RelationalPerson,
  RelationalTree,
  RelationalTreeBundle,
  RelationalUnion,
  TreeState,
  TreeWife,
} from './types'
import { orderChildrenByCode } from './treeUtils'

function maxCodeNumber(people: Person[], prefix: 'M' | 'F'): number {
  let max = 0
  function walk(person: Person) {
    if (person.id.startsWith(prefix)) {
      const n = Number(person.id.slice(1))
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
    person.children.forEach(walk)
  }
  people.forEach(walk)
  return max
}

function deriveCounters(root: Person | null) {
  if (!root) return { maleCounter: 1, femaleCounter: 0 }
  return {
    maleCounter: maxCodeNumber([root], 'M') + 1,
    femaleCounter: maxCodeNumber([root], 'F'),
  }
}

/**
 * Converts a hierarchical TreeState into the v2 relational bundle.
 * Canonical data only: tree metadata + persons + unions.
 */
export function treeToRelational(
  treeId: string,
  treeName: string,
  state: TreeState,
  updatedAt: string = new Date().toISOString(),
): RelationalTreeBundle {
  const persons: RelationalPerson[] = []
  const unions: RelationalUnion[] = []

  const codeToDbId = new Map<string, string>()
  function indexCodes(node: Person) {
    if (!node.dbId) node.dbId = crypto.randomUUID()
    codeToDbId.set(node.id, node.dbId)
    ;(node.children || []).forEach(indexCodes)
  }
  if (state.root) indexCodes(state.root)

  function walk(
    node: Person,
    parentDbId: string | null,
    birthOrder: number,
    parentWifeUnionIds: Map<string, string>,
  ) {
    const nodeDbId = node.dbId ?? crypto.randomUUID()
    node.dbId = nodeDbId

    // Create unions for this person's wives first, so children can reference them.
    const wifeUnionIds = new Map<string, string>()
    if (node.gender === 'M') {
      (node.wives || []).forEach((wife, idx) => {
        const unionDbId = wife.dbId ?? crypto.randomUUID()
        wife.dbId = unionDbId
        const union: RelationalUnion = {
          id: unionDbId,
          treeId,
          code: wife.id,
          husbandId: nodeDbId,
          wifePersonId: undefined,
          externalName: wife.type === 'external' ? wife.name : undefined,
          externalFamily: wife.type === 'external' ? wife.family : undefined,
          externalTribute: wife.type === 'external' ? wife.tribute : undefined,
          marriageOrder: idx,
          legacy: wife,
          updated_at: updatedAt,
          synced: true,
        }

        if (wife.type === 'tree') {
          // Only link a wife that belongs to this same tree. A cross-tree wife
          // keeps wife_person_id NULL and carries her source tree in `legacy`.
          // Looking her code up in this tree would attach a same-coded local
          // woman (e.g. F012 exists in both trees with different people).
          const isSameTree = !wife.treeId || wife.treeId === treeId
          union.wifePersonId = isSameTree
            ? codeToDbId.get(wife.personId) ?? undefined
            : undefined
        }

        unions.push(union)
        wifeUnionIds.set(wife.id, unionDbId)
      })
    }

    const motherUnionId = node.mother ? parentWifeUnionIds.get(node.mother) ?? null : null

    const relPerson: RelationalPerson = {
      id: nodeDbId,
      treeId,
      code: node.id,
      name: node.name,
      gender: node.gender,
      fatherId: parentDbId,
      motherUnionId,
      siblingOrder: birthOrder,
      branchMeta: node.branchMeta,
      updated_at: updatedAt,
      synced: true,
    }
    persons.push(relPerson)

    // Canonicalize at the persistence boundary as well: no caller can write a
    // daughter before a son (or a higher code before a lower one) by mistake.
    orderChildrenByCode(node.children || []).forEach((child, idx) => {
      walk(child, nodeDbId, idx, wifeUnionIds)
    })
  }

  if (state.root) {
    walk(state.root, null, 0, new Map())
  }

  const counters = deriveCounters(state.root)

  const relTree: RelationalTree = {
    id: treeId,
    name: treeName,
    rootPersonId: state.root ? state.root.dbId ?? null : null,
    version: 1,
    linkedFrom: state.linkedFrom,
    updated_at: updatedAt,
    synced: true,
  }

  // Keep rootPersonId stable after the walk assigned dbIds.
  if (state.root) {
    relTree.rootPersonId = state.root.dbId ?? null
  }

  void counters

  return {
    tree: relTree,
    persons,
    unions,
  }
}

/**
 * Reconstructs a hierarchical TreeState from v2 relational rows.
 */
export function relationalToTree(bundle: RelationalTreeBundle): TreeState {
  const { tree, persons, unions } = bundle

  if (persons.length === 0) {
    return {
      root: null,
      phase: 'complete',
      currentPersonId: null,
      maleCounter: 1,
      femaleCounter: 0,
      malesQueue: [],
      currentMaleIndex: 0,
      linkedFrom: tree.linkedFrom,
    }
  }

  const unionCodeById = new Map<string, string>()
  const unionsByHusband = new Map<string, RelationalUnion[]>()
  for (const u of unions) {
    unionCodeById.set(u.id, u.code ?? u.id)
    const list = unionsByHusband.get(u.husbandId) || []
    list.push(u)
    unionsByHusband.set(u.husbandId, list)
  }

  // Build every person node first so wives can resolve to codes even when the
  // wife appears later in the fetched persons array.
  const personByDbId = new Map<string, Person>()
  for (const p of persons) {
    personByDbId.set(p.id, {
      id: p.code,
      dbId: p.id,
      name: p.name,
      gender: p.gender,
      children: [],
      wives: [],
      mother: unionCodeById.get(p.motherUnionId ?? '') ?? undefined,
      branchMeta: p.branchMeta,
    })
  }

  for (const p of persons) {
    const personNode = personByDbId.get(p.id)
    if (!personNode) continue

    const husbandUnions = (unionsByHusband.get(p.id) || []).sort(
      (a, b) => (a.marriageOrder ?? 0) - (b.marriageOrder ?? 0),
    )

    personNode.wives = husbandUnions.map((u) => {
      const legacy = (u.legacy ?? {}) as any
      const wifeType =
        legacy?.type === 'tree' || legacy?.type === 'external'
          ? legacy.type
          : u.wifePersonId
            ? 'tree'
            : 'external'

      if (wifeType === 'tree') {
        const sourceTreeId = legacy?.treeId ?? legacy?.wifeTreeId
        const isCrossTree = Boolean(sourceTreeId && sourceTreeId !== tree.id)
        const linkedPerson =
          !isCrossTree && u.wifePersonId ? personByDbId.get(u.wifePersonId) : undefined
        const personCode =
          linkedPerson?.id ?? legacy?.personId ?? legacy?.wifePersonId ?? u.wifePersonId ?? ''
        const treeWife: TreeWife = {
          id: u.code ?? u.id,
          dbId: u.id,
          type: 'tree',
          personId: personCode,
          treeId: legacy?.treeId ?? legacy?.wifeTreeId,
          treeName: legacy?.treeName ?? legacy?.wifeTreeName,
          personName:
            legacy?.personName ?? legacy?.wifePersonName ?? linkedPerson?.name,
          lineageLabel: legacy?.lineageLabel ?? legacy?.wifeLineageLabel,
        }
        return treeWife
      }

      const extWife: ExternalWife = {
        id: u.code ?? u.id,
        dbId: u.id,
        type: 'external',
        name: u.externalName ?? legacy?.name ?? legacy?.externalName ?? '',
        family: u.externalFamily ?? legacy?.family ?? legacy?.externalFamily ?? '',
        tribute: u.externalTribute ?? legacy?.tribute ?? legacy?.externalTribute ?? '',
      }
      return extWife
    })
  }

  const childrenByFather = new Map<string, RelationalPerson[]>()
  for (const p of persons) {
    if (p.fatherId) {
      const list = childrenByFather.get(p.fatherId) || []
      list.push(p)
      childrenByFather.set(p.fatherId, list)
    }
  }
  for (const list of childrenByFather.values()) {
    list.sort(
      (a, b) =>
        (a.siblingOrder ?? 0) - (b.siblingOrder ?? 0) ||
        a.code.localeCompare(b.code),
    )
  }

  let rootNode: Person | null = null
  const rootDbId = tree.rootPersonId || persons.find((p) => !p.fatherId)?.id
  if (rootDbId) rootNode = personByDbId.get(rootDbId) || null

  // Connect children to fathers from the sibling-sorted groups. The order of
  // the fetched `persons` rows is not guaranteed, so attaching children while
  // walking that array would make the tree order change between reloads.
  for (const [fatherId, children] of childrenByFather) {
    const fatherNode = personByDbId.get(fatherId)
    if (!fatherNode) continue
    for (const child of children) {
      const childNode = personByDbId.get(child.id)
      if (childNode && !fatherNode.children.includes(childNode)) {
        fatherNode.children.push(childNode)
      }
    }
  }

  if (!rootNode && persons.length > 0) {
    rootNode = personByDbId.get(persons[0].id) || null
  }

  const counters = deriveCounters(rootNode)

  return {
    root: rootNode,
    phase: 'complete',
    currentPersonId: null,
    maleCounter: counters.maleCounter,
    femaleCounter: counters.femaleCounter,
    malesQueue: [],
    currentMaleIndex: 0,
    linkedFrom: tree.linkedFrom,
  }
}