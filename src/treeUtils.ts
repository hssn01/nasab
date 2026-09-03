import type { Person } from './types'

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

export function exportTree(root: Person): string {
  return JSON.stringify(root, null, 2)
}

export function exportOutline(root: Person): string {
  const lines: string[] = []
  function walk(node: Person, depth: number) {
    const wives = node.wives.length > 0 ? `  ⚭ ${node.wives.join(', ')}` : ''
    lines.push(`${'  '.repeat(depth)}${node.id}  ${node.name}${wives}`)
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

function normalizeArabic(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .trim()
}

/** Resolve a wife string (ID or name) to a female Person in the tree if she belongs to the same tribe. */
export function resolveWife(wifeStr: string, root: Person): Person | null {
  if (!wifeStr) return null
  const clean = wifeStr.trim()

  // 1. Match female ID e.g. "F012" or "F012 - فاطمة"
  const matchId = clean.match(/F\d{3,}/i)?.[0]?.toUpperCase()
  if (matchId) {
    const p = findPerson(root, matchId)
    if (p && p.gender === 'F') return p
  }

  // 2. Arabic normalized matching
  const normInput = normalizeArabic(clean)
  if (!normInput) return null

  const females = collectFemales(root)

  // 2a. Exact normalized match
  const exact = females.find((f) => normalizeArabic(f.name) === normInput)
  if (exact) return exact

  // 2b. Partial / Substring match (e.g. wife typed "فاطمة" matching female "فاطمة بنت أحمد")
  const partial = females.find((f) => {
    const normName = normalizeArabic(f.name)
    return (
      normName === normInput ||
      normName.startsWith(normInput) ||
      normInput.startsWith(normName)
    )
  })
  if (partial) return partial

  return null
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

export function findRelationship(root: Person, idA: string, idB: string): KinshipResult | null {
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

function getArabicKinshipTerm(dA: number, dB: number, pA: Person, pB: Person): string {
  const isFemale = pB.gender === 'F'

  if (dA === 0 && dB === 0) return 'نفس الشخص'
  if (dA === 0 && dB === 1) return isFemale ? 'ابنته المباشرة' : 'ابنه المباشر'
  if (dA === 1 && dB === 0) return pA.gender === 'F' ? 'والدتها' : 'والده'
  if (dA === 0 && dB === 2) return isFemale ? 'حفيدته' : 'حفيده'
  if (dA === 2 && dB === 0) return 'جده'
  if (dA === 0 && dB > 2) return isFemale ? `من حفيداته (جيل ${dB})` : `من أحفاده (جيل ${dB})`
  if (dA > 2 && dB === 0) return `من أجداده (جيل ${dA})`

  if (dA === 1 && dB === 1) return isFemale ? 'أخته' : 'أخوه'
  if (dA === 1 && dB === 2) return isFemale ? 'ابنة أخيه' : 'ابن أخيه'
  if (dA === 2 && dB === 1) return isFemale ? 'عمتها' : 'عمه'
  if (dA === 2 && dB === 2) return isFemale ? 'ابنة عمه' : 'ابن عمه'
  if (dA === 2 && dB === 3) return isFemale ? 'ابنة ابن عمه' : 'ابن ابن عمه'
  if (dA === 3 && dB === 2) return isFemale ? 'ابنة عم والده' : 'ابن عم والده'
  if (dA === 3 && dB === 3) return isFemale ? 'ابنة عمومة (من الدرجة الثانية)' : 'ابن عمومة (من الدرجة الثانية)'

  return isFemale ? `من قريباته (درجة ${dA + dB})` : `من أقربائه (درجة ${dA + dB})`
}



