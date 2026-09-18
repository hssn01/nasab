import type { BranchMeta, ExternalWife, Person, TreeLink, TreeState, TreeWife, Wife } from './types'

export function findPerson(root: Person, id: string): Person | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const found = findPerson(child, id)
    if (found) return found
  }
  return null
}

export function findParent(root: Person, id: string): Person | null {
  if (root.children.some((child) => child.id === id)) return root
  for (const child of root.children) {
    const found = findParent(child, id)
    if (found) return found
  }
  return null
}

export function findPath(root: Person, id: string): Person[] {
  function walk(node: Person, path: Person[]): Person[] | null {
    const next = [...path, node]
    if (node.id === id) return next
    for (const child of node.children) {
      const result = walk(child, next)
      if (result) return result
    }
    return null
  }
  return walk(root, []) ?? []
}

export function getLineageText(root: Person, id: string): string {
  const path = findPath(root, id)
  if (path.length === 0) return ''
  const reversed = [...path].reverse()
  return reversed
    .map((p, idx) => {
      if (idx === 0) return p.name
      const prev = reversed[idx - 1]
      const connector = prev.gender === 'F' ? 'بنت' : 'بن'
      return `${connector} ${p.name}`
    })
    .join(' ')
}

export function getSons(person: Person): Person[] {
  return person.children.filter((c) => c.gender === 'M')
}

/** After finishing children entry, find next person in DFS son-order traversal. */
export function advanceAfterDone(
  currentId: string,
  root: Person,
): Person | 'phase2' {
  const current = findPerson(root, currentId)
  if (!current) return 'phase2'

  const sons = getSons(current)
  if (sons.length > 0) return sons[0]

  const path = findPath(root, currentId)
  for (let depth = path.length - 1; depth >= 1; depth--) {
    const person = path[depth]
    const father = path[depth - 1]
    const fatherSons = getSons(father)
    const myIndex = fatherSons.findIndex((s) => s.id === person.id)
    if (myIndex >= 0 && myIndex < fatherSons.length - 1) {
      return fatherSons[myIndex + 1]
    }
  }

  return 'phase2'
}

/** Collect all males in DFS pre-order (father before descendants). */
export function collectMalesDFS(root: Person): Person[] {
  const result: Person[] = []
  function walk(node: Person) {
    if (node.gender === 'M') result.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return result
}

export function nextMaleId(counter: number): string {
  return `M${String(counter).padStart(3, '0')}`
}

export function nextFemaleId(counter: number): string {
  return `F${String(counter).padStart(3, '0')}`
}

export function newWifeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `w-${crypto.randomUUID()}`
  }
  return `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createTreeWife(
  personId: string,
  extra?: {
    treeId?: string
    treeName?: string
    personName?: string
    lineageLabel?: string
  },
): TreeWife {
  return {
    id: newWifeId(),
    type: 'tree',
    personId: personId.toUpperCase(),
    treeId: extra?.treeId,
    treeName: extra?.treeName,
    personName: extra?.personName,
    lineageLabel: extra?.lineageLabel,
  }
}

export function createExternalWife(
  name: string,
  family = '',
  tribute = '',
): ExternalWife {
  return {
    id: newWifeId(),
    type: 'external',
    name: name.trim(),
    family: family.trim(),
    tribute: tribute.trim(),
  }
}

export function isWife(value: unknown): value is Wife {
  if (!value || typeof value !== 'object') return false
  const wife = value as Partial<Wife>
  if (typeof wife.id !== 'string' || !wife.id) return false
  if (wife.type === 'tree') {
    return typeof (wife as TreeWife).personId === 'string'
  }
  if (wife.type === 'external') {
    const external = wife as ExternalWife
    return (
      typeof external.name === 'string' &&
      typeof external.family === 'string' &&
      typeof external.tribute === 'string'
    )
  }
  return false
}

/** Accept Wife objects or legacy string entries. */
export function normalizeWife(raw: unknown, index = 0): Wife | null {
  if (isWife(raw)) {
    if (raw.type === 'tree') {
      const tw = raw as TreeWife
      return {
        id: tw.id,
        type: 'tree',
        personId: tw.personId.toUpperCase(),
        treeId: tw.treeId,
        treeName: tw.treeName,
        personName: tw.personName,
        lineageLabel: tw.lineageLabel,
      }
    }
    return {
      id: raw.id,
      type: 'external',
      name: raw.name.trim(),
      family: raw.family.trim(),
      tribute: raw.tribute.trim(),
    }
  }

  if (typeof raw !== 'string') return null
  const clean = raw.trim()
  if (!clean) return null

  const idMatch = clean.match(/F\d{3,}/i)?.[0]
  if (idMatch) {
    return {
      id: `legacy-w-${index}-${idMatch.toUpperCase()}`,
      type: 'tree',
      personId: idMatch.toUpperCase(),
    }
  }

  return {
    id: `legacy-w-${index}-${clean.slice(0, 24)}`,
    type: 'external',
    name: clean,
    family: '',
    tribute: '',
  }
}

export function normalizeWives(raw: unknown): Wife[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item, index) => normalizeWife(item, index))
    .filter((wife): wife is Wife => wife !== null)
}

/** Resolve a tree-linked wife (or legacy string) to a Person. */
export function resolveWife(
  wife: Wife | string | null | undefined,
  root: Person,
): Person | null {
  if (!wife) return null

  if (typeof wife !== 'string') {
    if (wife.type === 'tree') {
      const person = findPerson(root, wife.personId)
      return person?.gender === 'F' ? person : null
    }
    return null
  }

  const clean = wife.trim()
  const matchId = clean.match(/F\d{3,}/i)?.[0]?.toUpperCase()
  if (matchId) {
    const person = findPerson(root, matchId)
    if (person?.gender === 'F') return person
  }

  const normInput = normalizeArabic(clean)
  if (!normInput) return null

  const females = collectFemales(root)
  const exact = females.find((f) => normalizeArabic(f.name) === normInput)
  if (exact) return exact

  const partial = females.find((f) => {
    const normName = normalizeArabic(f.name)
    return (
      normName === normInput ||
      normName.startsWith(normInput) ||
      normInput.startsWith(normName)
    )
  })
  return partial ?? null
}

export function wifeDisplayName(wife: Wife, root: Person): string {
  if (wife.type === 'tree') {
    const linked = resolveWife(wife, root)
    if (linked) return linked.name
    if (wife.personName) return wife.personName
    return wife.personId
  }
  return wife.name || 'زوجة'
}

export function wifeShortLabel(wife: Wife, root: Person): string {
  if (typeof (wife as unknown) === 'string') {
    return wife as unknown as string
  }
  if (!wife) return ''
  if (wife.type === 'tree') {
    const linked = resolveWife(wife, root)
    if (linked) {
      return `${linked.name} (${linked.id})`
    }
    if (wife.personName) {
      const fromTree = wife.treeName ? ` [من: ${wife.treeName}]` : ''
      return `${wife.personName}${fromTree} (${wife.personId})`
    }
    return `من الشجرة · ${wife.personId}`
  }
  const family = wife.family ? ` · ${wife.family}` : ''
  return `${wife.name || 'زوجة'}${family}`
}

export function findWifeByMotherKey(
  father: Person,
  motherKey: unknown,
): Wife | null {
  if (!motherKey || !Array.isArray(father.wives)) return null

  let targetId = ''
  let targetName = ''

  if (typeof motherKey === 'object' && motherKey !== null) {
    const raw = motherKey as { id?: unknown; name?: unknown; personId?: unknown }
    targetId = typeof raw.id === 'string' ? raw.id.trim() : ''
    targetName =
      typeof raw.name === 'string'
        ? raw.name.trim()
        : typeof raw.personId === 'string'
          ? raw.personId.trim()
          : ''
  } else if (typeof motherKey === 'string') {
    targetId = motherKey.trim()
    targetName = motherKey.trim()
  }

  if (targetId) {
    const byId = father.wives.find((wife) => wife.id === targetId)
    if (byId) return byId
  }

  if (targetName) {
    return (
      father.wives.find((wife) => {
        if (wife.type === 'external') return wife.name === targetName
        return wife.personId === targetName
      }) ?? null
    )
  }

  return null
}

export function motherDisplayLabel(
  child: Person,
  father: Person | null,
  root: Person,
): string {
  if (!child.mother) return ''
  const motherVal: unknown = child.mother

  if (father) {
    const wife = findWifeByMotherKey(father, motherVal)
    if (wife) return wifeDisplayName(wife, root)
  }

  if (typeof motherVal === 'object' && motherVal !== null) {
    const raw = motherVal as { name?: unknown; id?: unknown; personId?: unknown }
    return (
      (typeof raw.name === 'string' && raw.name) ||
      (typeof raw.personId === 'string' && raw.personId) ||
      (typeof raw.id === 'string' && raw.id) ||
      ''
    )
  }

  return typeof motherVal === 'string' ? motherVal.trim() : ''
}

/** Normalize wives arrays on a whole tree (legacy string → Wife) and ensure mother keys are clean strings. */
export function normalizePersonTree(root: Person): Person {
  function walk(node: Person, father: Person | null = null): Person {
    const wives = normalizeWives(node.wives)

    let mother: string | null = null
    if (node.mother) {
      if (typeof node.mother === 'object' && node.mother !== null) {
        const raw = node.mother as { id?: unknown; name?: unknown; personId?: unknown }
        mother =
          (typeof raw.id === 'string' && raw.id.trim()) ||
          (typeof raw.name === 'string' && raw.name.trim()) ||
          (typeof raw.personId === 'string' && raw.personId.trim()) ||
          null
      } else if (typeof node.mother === 'string') {
        mother = node.mother.trim() || null
      }
    }

    if (mother && father && Array.isArray(father.wives)) {
      const byId = father.wives.find((wife) => wife.id === mother)
      if (byId) {
        mother = byId.id
      } else {
        const byLegacy = father.wives.find((wife) => {
          if (wife.type === 'external') return wife.name === mother
          return wife.personId === mother || mother!.includes(wife.personId)
        })
        if (byLegacy) mother = byLegacy.id
      }
    }

    const normalizedNode: Person = {
      ...node,
      wives,
      mother,
      children: [],
    }

    normalizedNode.children = (node.children || []).map((child) =>
      walk(child, normalizedNode),
    )
    return normalizedNode
  }

  return walk(root, null)
}

export function exportTree(root: Person): string {
  return JSON.stringify(root, null, 2)
}

export function exportOutline(root: Person): string {
  const lines: string[] = []
  function walk(node: Person, depth: number) {
    const wivesLabel =
      node.wives.length > 0
        ? `  ⚭ ${node.wives.map((wife) => wifeShortLabel(wife, root)).join('، ')}`
        : ''
    const mother = node.mother
      ? `  ❀ أمّه: ${motherDisplayLabel(node, findParent(root, node.id), root)}`
      : ''
    lines.push(
      `${'  '.repeat(depth)}${node.id}  ${node.name}${wivesLabel}${mother}`,
    )
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return lines.join('\n')
}

export function countPeople(root: Person): { males: number; females: number } {
  let males = 0
  let females = 0
  function walk(node: Person) {
    if (node.gender === 'M') males++
    else females++
    for (const child of node.children) walk(child)
  }
  walk(root)
  return { males, females }
}

/** Collect all females in tree. */
export function collectFemales(root: Person): Person[] {
  const result: Person[] = []
  function walk(node: Person) {
    if (node.gender === 'F') result.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return result
}

export interface FemaleWithLineage {
  person: Person
  father: Person | null
  /** Full patronymic chain e.g. "فاطمة بنت عبد الله بن محمد" */
  lineageLabel: string
}

/**
 * Collect all females in the tree enriched with their full patronymic lineage
 * string and a direct reference to their father (or null for a root female).
 */
export function collectFemalesWithLineage(root: Person): FemaleWithLineage[] {
  const result: FemaleWithLineage[] = []

  function walk(node: Person, ancestors: Person[]) {
    if (node.gender === 'F') {
      const father = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null
      // Build patronymic: "فاطمة بنت أبيها بن جدها بن…"
      const parts: string[] = [node.name]
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const sep = i === ancestors.length - 1 ? 'بنت' : 'بن'
        parts.push(sep, ancestors[i].name)
      }
      result.push({ person: node, father, lineageLabel: parts.join(' ') })
    }
    for (const child of node.children) walk(child, [...ancestors, node])
  }

  walk(root, [])
  return result
}

/** Returns the full patronymic label for a single female by id. */
export function getFemaleFullLineage(root: Person, femaleId: string): string {
  const all = collectFemalesWithLineage(root)
  return all.find((f) => f.person.id === femaleId)?.lineageLabel ?? femaleId
}

function normalizeArabic(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .trim()
}

export interface KinshipResult {
  personA: Person
  personB: Person
  commonAncestor: Person | null
  distanceA: number
  distanceB: number
  relationshipTitle: string
  lineageA: Person[]
  lineageB: Person[]
}

export function findRelationship(
  root: Person,
  idA: string,
  idB: string,
): KinshipResult | null {
  const personA = findPerson(root, idA)
  const personB = findPerson(root, idB)
  if (!personA || !personB) return null

  // Helper to retrieve both father and mother (if known) of a person
  const getParents = (person: Person): Person[] => {
    const parents: Person[] = []
    const father = findParent(root, person.id)
    if (father) parents.push(father)
    if (person.mother && typeof person.mother === 'string') {
      const mother = findPerson(root, person.mother)
      if (mother) parents.push(mother)
    }
    return parents
  }

  // Build a map of ancestorId -> {dist, nextChildId}
  const buildAncestorMap = (start: Person) => {
    const map = new Map<string, { dist: number; next: string | null }>()
    const queue: Array<{ node: Person; dist: number; childId: string | null }> = [{ node: start, dist: 0, childId: null }]
    while (queue.length) {
      const { node, dist, childId } = queue.shift()!
      if (map.has(node.id)) continue
      map.set(node.id, { dist, next: childId })
      const parents = getParents(node)
      for (const p of parents) {
        queue.push({ node: p, dist: dist + 1, childId: node.id })
      }
    }
    return map
  }

  const ancestorsA = buildAncestorMap(personA)
  const ancestorsB = buildAncestorMap(personB)

  // Find common ancestor with minimal combined distance (closest relationship)
  let bestAncestorId: string | null = null
  let bestDistSum = Infinity
  let bestDistA = 0
  let bestDistB = 0
  for (const [ancId, aInfo] of ancestorsA.entries()) {
    const bInfo = ancestorsB.get(ancId)
    if (!bInfo) continue
    const sum = aInfo.dist + bInfo.dist
    if (sum < bestDistSum || (sum === bestDistSum && Math.max(aInfo.dist, bInfo.dist) < Math.max(bestDistA, bestDistB))) {
      bestDistSum = sum
      bestAncestorId = ancId
      bestDistA = aInfo.dist
      bestDistB = bInfo.dist
    }
  }

  if (!bestAncestorId) return null
  const commonAncestor = findPerson(root, bestAncestorId)
  if (!commonAncestor) return null

  const title = getArabicKinshipTerm(bestDistA, bestDistB, personA, personB)

  // Build full root-to-person paths and slice from the closest common ancestor
  const pathA = findPath(root, idA)
  const pathB = findPath(root, idB)
  const idxA = pathA.findIndex(p => p.id === bestAncestorId)
  const idxB = pathB.findIndex(p => p.id === bestAncestorId)
  const lineageA = idxA !== -1 ? pathA.slice(idxA) : []
  const lineageB = idxB !== -1 ? pathB.slice(idxB) : []

  return {
    personA,
    personB,
    commonAncestor,
    distanceA: bestDistA,
    distanceB: bestDistB,
    relationshipTitle: title,
    lineageA,
    lineageB,
  }
}

function getArabicKinshipTerm(
  dA: number,
  dB: number,
  pA: Person,
  pB: Person,
): string {
  const isFemale = pB.gender === 'F';

  if (dA === 0 && dB === 0) return 'نفس الشخص';
  if (dA === 0 && dB === 1) return isFemale ? 'ابنته المباشرة' : 'ابنه المباشر';
  if (dA === 1 && dB === 0) return pA.gender === 'F' ? 'والدتها' : 'والده';
  if (dA === 0 && dB === 2) return isFemale ? 'حفيدته' : 'حفيده';
  if (dA === 2 && dB === 0) return 'جده';
  if (dA === 0 && dB > 2)
    return isFemale ? `من حفيداته (جيل ${dB})` : `من أحفاده (جيل ${dB})`;
  if (dA > 2 && dB === 0) return `من أجداده (جيل ${dA})`;

  if (dA === 1 && dB === 1) return isFemale ? 'أخته' : 'أخوه';
  if (dA === 1 && dB === 2) return isFemale ? 'ابنة أخيه' : 'ابن أخيه';
  if (dA === 2 && dB === 1) return isFemale ? 'عمتها' : 'عمه';
  if (dA === 2 && dB === 2) return isFemale ? 'ابنة عمه' : 'ابن عمه';
  if (dA === 2 && dB === 3) return isFemale ? 'ابنة ابن عمه' : 'ابن ابن عمه';
  if (dA === 3 && dB === 2) return isFemale ? 'ابنة عم والده' : 'ابن عم والده';
  if (dA === 3 && dB === 3)
    return isFemale
      ? 'ابنة عمومة (من الدرجة الثانية)'
      : 'ابن عمومة (من الدرجة الثانية)';

  return isFemale
    ? `من قريباته (درجة ${dA + dB})`
    : `من أقربائه (درجة ${dA + dB})`;
}




// ── Multi-Tree Unification for Web View ───────────────────────────────────────

export function findPersonByName(root: Person, name: string): Person | null {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ىي]/g, 'ي')
      .trim()
      .toLowerCase()

  const target = norm(name)
  if (!target) return null

  const all: Person[] = []
  function walk(p: Person) {
    all.push(p)
    p.children.forEach(walk)
  }
  walk(root)

  // 1. Exact match
  const exact = all.find((p) => norm(p.name) === target)
  if (exact) return exact

  // 2. Token match before "بنت" or "ابنة" or "بن" or "ابن"
  const firstWord = target.split(/\s+(?:بنت|ابنة|بن|ابن)\s+/)[0]?.trim()
  if (firstWord && firstWord !== target) {
    const byFirst = all.find((p) => norm(p.name) === firstWord)
    if (byFirst) return byFirst
  }

  // 3. Starts with or includes
  const byPrefix = all.find((p) => {
    const n = norm(p.name)
    return target.startsWith(n) || n.startsWith(target) || target.includes(n) || n.includes(target)
  })
  if (byPrefix) return byPrefix

  return null
}

export function findFemaleByNameOrId(root: Person, id?: string, name?: string): Person | null {
  if (id) {
    const p = findPerson(root, id)
    if (p) return p
  }
  if (!name) return null
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/[ىي]/g, 'ي')
      .trim()
      .toLowerCase()

  const target = norm(name)
  if (!target) return null

  const females = collectFemales(root)

  // 1. Exact female match
  const exact = females.find((f) => norm(f.name) === target)
  if (exact) return exact

  // 2. First word before "بنت" or "ابنة"
  const firstWord = target.split(/\s+(?:بنت|ابنة)\s+/)[0]?.trim()
  if (firstWord && firstWord !== target) {
    const byFirst = females.find((f) => norm(f.name) === firstWord)
    if (byFirst) return byFirst
  }

  // 3. Prefix or includes among females
  const byPrefix = females.find((f) => {
    const n = norm(f.name)
    return target.startsWith(n) || n.startsWith(target) || target.includes(n) || n.includes(target)
  })
  if (byPrefix) return byPrefix

  // Fallback to any node in tree
  return findPersonByName(root, name)
}

export interface ConnectedBranchInput {
  id: string
  name: string
  state: TreeState
  linkedFrom?: TreeLink
}

export interface UnifiedTreeResult {
  root: Person
  branchCount: number
  connectedTreeIds: string[]
  isUnified: boolean
}

/**
 * Merges connected family trees (daughter branches, brother branches, etc.)
 * into a single unified tree hierarchy for viewing in visual charts and outlines.
 */
export function buildUnifiedTree(
  mainTreeId: string,
  mainRoot: Person,
  mainTreeName: string,
  connectedBranches: ConnectedBranchInput[],
): UnifiedTreeResult {
  if (!connectedBranches || connectedBranches.length === 0) {
    return {
      root: mainRoot,
      branchCount: 0,
      connectedTreeIds: [mainTreeId],
      isUnified: false,
    }
  }

  // Deeply clone and tag nodes with metadata, prefixing IDs to prevent collisions
  function cloneAndTag(
    person: Person,
    prefix: string,
    meta: BranchMeta,
  ): Person {
    return {
      id: prefix ? `${prefix}${person.id}` : person.id,
      name: person.name,
      gender: person.gender,
      mother: person.mother,
      branchMeta: {
        ...meta,
        originalId: person.id,
      },
      wives: person.wives.map((w) => ({ ...w })),
      children: person.children.map((child) => cloneAndTag(child, prefix, meta)),
    }
  }

  const mainMeta: BranchMeta = {
    treeId: mainTreeId,
    treeName: mainTreeName,
    type: 'main',
  }

  const clonedMain = cloneAndTag(mainRoot, '', mainMeta)

  const daughterBranches: { branch: ConnectedBranchInput; clonedRoot: Person }[] = []
  const brotherBranches: { branch: ConnectedBranchInput; clonedRoot: Person }[] = []
  const otherBranches: { branch: ConnectedBranchInput; clonedRoot: Person }[] = []
  const validConnectedIds: string[] = [mainTreeId]

  for (const b of connectedBranches) {
    if (!b.state?.root) continue
    validConnectedIds.push(b.id)
    const prefix = `br_${b.id.slice(0, 6)}_`
    const bType = b.linkedFrom?.type || 'other'
    const bMeta: BranchMeta = {
      treeId: b.id,
      treeName: b.name,
      type: bType,
      personName: b.linkedFrom?.personName,
    }

    const clonedRoot = cloneAndTag(b.state.root, prefix, bMeta)

    if (bType === 'daughter-branch') {
      daughterBranches.push({ branch: b, clonedRoot })
    } else if (bType === 'brother-branch') {
      brotherBranches.push({ branch: b, clonedRoot })
    } else {
      otherBranches.push({ branch: b, clonedRoot })
    }
  }

  // Attach daughter branches to their linking daughter in the tree
  for (const { branch, clonedRoot } of daughterBranches) {
    const targetPersonId = branch.linkedFrom?.personId
    const targetPersonName = branch.linkedFrom?.personName

    const targetNode: Person | null = findFemaleByNameOrId(clonedMain, targetPersonId, targetPersonName)

    if (targetNode) {
      // Mark the daughter node as having a linked branch
      targetNode.branchMeta = {
        treeId: branch.id,
        treeName: branch.name,
        type: 'daughter-branch',
        personName: targetNode.name,
      }

      // Check if clonedRoot is the daughter herself
      const normSimple = (s: string) =>
        s.replace(/[\u0640\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىي]/g, 'ي').trim().toLowerCase()
      const isSameAsDaughter =
        normSimple(clonedRoot.name) === normSimple(targetNode.name) ||
        normSimple(clonedRoot.name) === `ابناء ${normSimple(targetNode.name)}` ||
        normSimple(clonedRoot.name) === `ذريه ${normSimple(targetNode.name)}`

      if (isSameAsDaughter && clonedRoot.children.length > 0) {
        // Direct attachment: attach her children directly to her node (avoids repeating daughter -> daughter)
        targetNode.children = [...targetNode.children, ...clonedRoot.children]
      } else {
        // Direct attachment: daughter node now connects directly to her branch tree
        targetNode.children = [...targetNode.children, clonedRoot]
      }
    } else {
      // Fallback: attach under clonedMain root
      clonedMain.children = [...clonedMain.children, clonedRoot]
    }
  }

  // Attach other branches
  for (const { branch, clonedRoot } of otherBranches) {
    const targetPersonId = branch.linkedFrom?.personId
    let targetNode = targetPersonId ? findPerson(clonedMain, targetPersonId) : null
    if (!targetNode && branch.linkedFrom?.personName) {
      targetNode = findPersonByName(clonedMain, branch.linkedFrom.personName)
    }
    if (targetNode) {
      targetNode.children = [...targetNode.children, clonedRoot]
    } else {
      brotherBranches.push({ branch, clonedRoot })
    }
  }

  // If there are brother branches, wrap together in a common ancestor root node
  if (brotherBranches.length > 0) {
    const brotherRoots = brotherBranches.map((b) => b.clonedRoot)
    const commonFatherTitle =
      mainRoot.name.startsWith('شجرة')
        ? `الأصل الجامع (${mainRoot.name})`
        : `الأصل المشترك (جامع آل ${mainRoot.name} وإخوته)`

    const containerRoot: Person = {
      id: `__COMMON_ROOT__`,
      name: commonFatherTitle,
      gender: 'M',
      children: [clonedMain, ...brotherRoots],
      wives: [],
      mother: null,
      branchMeta: {
        treeId: mainTreeId,
        treeName: 'الأصل الجامع',
        type: 'main',
        isVirtualContainer: true,
      },
    }

    return {
      root: containerRoot,
      branchCount: daughterBranches.length + brotherBranches.length + otherBranches.length,
      connectedTreeIds: validConnectedIds,
      isUnified: true,
    }
  }

  return {
    root: clonedMain,
    branchCount: daughterBranches.length + otherBranches.length,
    connectedTreeIds: validConnectedIds,
    isUnified: daughterBranches.length > 0 || otherBranches.length > 0,
  }
}

