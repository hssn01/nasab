import type { ExternalWife, Person, TreeWife, Wife } from './types'

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
  return [...path]
    .reverse()
    .map((p) => p.name)
    .join(' بن ')
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

export function createTreeWife(personId: string): TreeWife {
  return { id: newWifeId(), type: 'tree', personId: personId.toUpperCase() }
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
      return {
        id: raw.id,
        type: 'tree',
        personId: raw.personId.toUpperCase(),
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
    return linked ? linked.name : wife.personId
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
    return linked
      ? `${linked.name} (${linked.id})`
      : `من الشجرة · ${wife.personId}`
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

  const pathA = findPath(root, idA)
  const pathB = findPath(root, idB)

  let lcaIndex = -1
  const minLen = Math.min(pathA.length, pathB.length)
  for (let i = 0; i < minLen; i++) {
    if (pathA[i].id === pathB[i].id) {
      lcaIndex = i
    } else {
      break
    }
  }

  if (lcaIndex === -1) return null

  const commonAncestor = pathA[lcaIndex]
  const distA = pathA.length - 1 - lcaIndex
  const distB = pathB.length - 1 - lcaIndex

  const title = getArabicKinshipTerm(distA, distB, personA, personB)

  return {
    personA,
    personB,
    commonAncestor,
    distanceA: distA,
    distanceB: distB,
    relationshipTitle: title,
    lineageA: pathA.slice(lcaIndex),
    lineageB: pathB.slice(lcaIndex),
  }
}

function getArabicKinshipTerm(
  dA: number,
  dB: number,
  pA: Person,
  pB: Person,
): string {
  const isFemale = pB.gender === 'F'

  if (dA === 0 && dB === 0) return 'نفس الشخص'
  if (dA === 0 && dB === 1) return isFemale ? 'ابنته المباشرة' : 'ابنه المباشر'
  if (dA === 1 && dB === 0) return pA.gender === 'F' ? 'والدتها' : 'والده'
  if (dA === 0 && dB === 2) return isFemale ? 'حفيدته' : 'حفيده'
  if (dA === 2 && dB === 0) return 'جده'
  if (dA === 0 && dB > 2)
    return isFemale ? `من حفيداته (جيل ${dB})` : `من أحفاده (جيل ${dB})`
  if (dA > 2 && dB === 0) return `من أجداده (جيل ${dA})`

  if (dA === 1 && dB === 1) return isFemale ? 'أخته' : 'أخوه'
  if (dA === 1 && dB === 2) return isFemale ? 'ابنة أخيه' : 'ابن أخيه'
  if (dA === 2 && dB === 1) return isFemale ? 'عمتها' : 'عمه'
  if (dA === 2 && dB === 2) return isFemale ? 'ابنة عمه' : 'ابن عمه'
  if (dA === 2 && dB === 3) return isFemale ? 'ابنة ابن عمه' : 'ابن ابن عمه'
  if (dA === 3 && dB === 2) return isFemale ? 'ابنة عم والده' : 'ابن عم والده'
  if (dA === 3 && dB === 3)
    return isFemale
      ? 'ابنة عمومة (من الدرجة الثانية)'
      : 'ابن عمومة (من الدرجة الثانية)'

  return isFemale
    ? `من قريباته (درجة ${dA + dB})`
    : `من أقربائه (درجة ${dA + dB})`
}
