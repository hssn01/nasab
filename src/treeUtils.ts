import type { BranchMeta, ExternalWife, Person, TreeLink, TreeState, TreeWife, Wife } from './types'

export function isMatchingPersonId(node: Person, targetId: string): boolean {
  if (!node || !targetId) return false
  if (node.id === targetId) return true
  const normTarget = targetId.toUpperCase().trim()
  const nId = node.id.toUpperCase().trim()
  if (nId === normTarget) return true
  if (node.branchMeta?.originalId && node.branchMeta.originalId.toUpperCase().trim() === normTarget) return true
  if (nId.endsWith(`_${normTarget}`)) return true
  if (nId.replace(/^BR_[A-Z0-9]+_/, '') === normTarget) return true
  return false
}

export interface TreeSaveValidation {
  ok: boolean
  reason?: string
}

/**
 * Guard used before persisting a tree. A saved tree must contain only its own
 * canonical person IDs (M001/F001 style). Merged multi-tree display states —
 * virtual common roots, branch-prefixed IDs, linked spouses and non-main
 * branch metadata — must never be written back over the base tree.
 */
export function validateTreeForSave(root: Person | null): TreeSaveValidation {
  if (!root) return { ok: false, reason: 'missing-root' }
  if (root.id === '__COMMON_ROOT__') return { ok: false, reason: 'virtual-root' }

  const seen = new Set<string>()

  function walk(person: Person): TreeSaveValidation {
    if (!/^[MF]\d{3,}$/.test(person.id)) {
      return { ok: false, reason: `invalid-id:${person.id}` }
    }
    if (seen.has(person.id)) {
      return { ok: false, reason: `duplicate-id:${person.id}` }
    }
    seen.add(person.id)

    if (person.branchMeta?.isVirtualContainer) {
      return { ok: false, reason: `virtual-container:${person.id}` }
    }
    if (person.branchMeta && person.branchMeta.type !== 'main') {
      return { ok: false, reason: `branch-meta:${person.branchMeta.type}:${person.id}` }
    }
    if (person.linkedSpouse) {
      return { ok: false, reason: `linked-spouse:${person.id}` }
    }

    for (const child of person.children) {
      const result = walk(child)
      if (!result.ok) return result
    }
    return { ok: true }
  }

  return walk(root)
}

export function findPerson(root: Person, id: string): Person | null {
  if (isMatchingPersonId(root, id)) return root
  if (root.linkedSpouse) {
    const sFound = findPerson(root.linkedSpouse, id)
    if (sFound) return sFound
  }
  for (const child of root.children) {
    const found = findPerson(child, id)
    if (found) return found
  }
  return null
}

export function findParent(root: Person, id: string): Person | null {
  if (root.children.some((child) => isMatchingPersonId(child, id))) return root
  if (root.linkedSpouse && isMatchingPersonId(root.linkedSpouse, id)) return root
  for (const child of root.children) {
    const found = findParent(child, id)
    if (found) return found
  }
  return null
}

export function findPath(root: Person, id: string): Person[] {
  function walk(node: Person, path: Person[]): Person[] | null {
    const next = [...path, node]
    if (isMatchingPersonId(node, id)) return next
    for (const child of node.children) {
      const result = walk(child, next)
      if (result) return result
    }
    return null
  }
  return walk(root, []) ?? []
}

function formatAncestralPath(path: Person[]): string {
  const cleanPath = path.filter((p) => {
    if (p.id === '__COMMON_ROOT__') {
      return Boolean(p.branchMeta?.personName)
    }
    return true
  })
  if (cleanPath.length === 0) return ''
  const reversed = [...cleanPath].reverse()
  return reversed
    .map((p, idx) => {
      const name = p.id === '__COMMON_ROOT__' && p.branchMeta?.personName ? p.branchMeta.personName : p.name
      if (idx === 0) return cleanLineageText(name)
      const prev = reversed[idx - 1]
      const connector = prev.gender === 'F' ? 'بنت' : 'بن'
      return `${connector} ${cleanLineageText(name)}`
    })
    .join(' ')
}

const lineageTextCache = new WeakMap<Person, Map<string, string>>()

export function getLineageText(root: Person, id: string): string {
  let cache = lineageTextCache.get(root)
  if (!cache) {
    cache = new Map()
    lineageTextCache.set(root, cache)
  }
  const cached = cache.get(id)
  if (cached !== undefined) return cached

  // One traversal supplies both the target and its path. Linked spouses are
  // not part of findPath's child walk, so fall back to findPerson for them.
  let path = findPath(root, id)
  const target = path[path.length - 1] ?? findPerson(root, id)
  if (target?.branchMeta?.treeId) {
    // If the target person is from a linked branch, prefer their biological
    // lineage in their source tree.
    const sourceRoot = getCachedTreeRoot(target.branchMeta.treeId)
    if (sourceRoot) {
      const origId = target.branchMeta.originalId || target.id
      const sourcePath = findPath(sourceRoot, origId)
      if (sourcePath.length > 0) {
        const text = formatAncestralPath(sourcePath)
        cache.set(id, text)
        return text
      }
    }
  }

  if (path.length === 0) {
    for (const otherRoot of getAllKnownCachedRoots()) {
      const p = findPath(otherRoot, id)
      if (p.length > 0) {
        path = p
        break
      }
    }
  }
  const text = path.length === 0 ? '' : formatAncestralPath(path)
  cache.set(id, text)
  return text
}

export function getSons(person: Person): Person[] {
  return person.children.filter((c) => c.gender === 'M')
}

/**
 * Deterministic sibling order used by the editor:
 * all sons first, then all daughters, each group ordered by the numeric part
 * of its M/F code. The male and female counters are independent, so an M
 * code is never compared with an F code.
 */
export function orderChildrenByCode(children: Person[]): Person[] {
  function codeNumber(person: Person): number {
    const match = /^[MF](\d+)$/.exec(person.id)
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  }

  function sortGroup(group: Person[]): Person[] {
    return [...group].sort((a, b) => {
      const difference = codeNumber(a) - codeNumber(b)
      return difference !== 0 ? difference : a.id.localeCompare(b.id)
    })
  }

  return [
    ...sortGroup(children.filter((child) => child.gender === 'M')),
    ...sortGroup(children.filter((child) => child.gender === 'F')),
  ]
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
        dbId: tw.dbId,
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
      dbId: raw.dbId,
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

// Parsing the same large tree cache on every lineage/render call was the main
// cost of switching the unified view on for a 2,000+ person tree. Keep the
// parsed root keyed by the raw localStorage value; a write changes the string
// and causes exactly one re-parse.
const cachedTreeRootEntries = new Map<string, { raw: string; root: Person | null }>()

function readCachedTreeRoot(treeId: string): Person | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem('nasab-cache-v1-' + treeId)
    if (!raw) {
      cachedTreeRootEntries.delete(treeId)
      return null
    }
    const cached = cachedTreeRootEntries.get(treeId)
    if (cached?.raw === raw) return cached.root
    const parsed = JSON.parse(raw) as TreeState
    const root = parsed?.root ?? null
    cachedTreeRootEntries.set(treeId, { raw, root })
    return root
  } catch {
    cachedTreeRootEntries.delete(treeId)
    return null
  }
}

export function getCachedTreeRoot(treeId: string): Person | null {
  return readCachedTreeRoot(treeId)
}

export function getAllKnownCachedRoots(): Person[] {
  const roots: Person[] = []
  try {
    if (typeof localStorage === 'undefined') return roots
    const seenRoots = new Set<string>()

    // 1. Scan all localStorage keys starting with nasab-cache-v1-
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('nasab-cache-v1-')) {
        const treeId = key.slice('nasab-cache-v1-'.length)
        const root = readCachedTreeRoot(treeId)
        if (root && !seenRoots.has(root.id)) {
          seenRoots.add(root.id)
          roots.push(root)
        }
      }
    }

    // 2. Also check device tree ids
    const rawIds = localStorage.getItem('nasab-device-trees-v1')
    const ids: string[] = rawIds ? JSON.parse(rawIds) : []
    for (const id of ids) {
      const r = readCachedTreeRoot(id)
      if (r && !seenRoots.has(r.id)) {
        seenRoots.add(r.id)
        roots.push(r)
      }
    }
  } catch {
    // ignore
  }
  return roots
}

/** Resolve a tree-linked wife (or legacy string) to a Person. */
export function resolveWife(
  wife: Wife | string | null | undefined,
  root: Person,
): Person | null {
  if (!wife) return null

  const isF = (p: Person) =>
    !p.gender ||
    p.gender === 'F' ||
    (p.gender as string).toUpperCase() === 'F' ||
    p.id.toUpperCase().includes('F') ||
    (p.branchMeta?.originalId ? p.branchMeta.originalId.toUpperCase().includes('F') : false)

  if (typeof wife !== 'string') {
    if (wife.type === 'tree') {
      const targetId = wife.personId?.toUpperCase()?.trim()
      if (!targetId) return null

      const targetTreeId = wife.treeId
      // 1. If wife belongs to a specific tree (cross-tree wife):
      if (targetTreeId) {
        // 1a. Try prefixed ID in unified tree: `br_<treeId.slice(0,6)>_<personId>`
        const prefix = `br_${targetTreeId.slice(0, 6)}_`
        const prefixed = findPerson(root, `${prefix}${targetId}`)
        if (prefixed && isF(prefixed)) return prefixed

        // 1b. Deep search for matching female by originalId and treeId
        let match: Person | null = null
        function walkTree(node: Person) {
          if (match) return
          if (
            isF(node) &&
            node.branchMeta?.treeId === targetTreeId &&
            isMatchingPersonId(node, targetId)
          ) {
            match = node
            return
          }
          if (node.linkedSpouse) walkTree(node.linkedSpouse)
          for (const child of node.children) {
            walkTree(child)
          }
        }
        walkTree(root)
        if (match) return match

        // Do not resolve a cross-tree wife against a cached copy of another
        // tree here. Her tag would then carry that other tree's person id,
        // which can collide with a same-coded woman in the displayed root and
        // navigate to the wrong person. Callers render her legacy label and
        // open her source tree instead.
        return null
      }

      // 2. Same-tree wife (no treeId on wife). In a unified view the main tree
      // and its branches can contain the same code (F010 in the main tree is a
      // different woman from F010 in a branch). A same-tree wife only exists in
      // the tree being displayed, never in a `br_...` clone, so skip branches
      // entirely instead of silently attaching a same-coded woman.
      const isBranchClone = (p: Person) => /^br_[a-z0-9]+_/i.test(p.id)

      function findSameTreePerson(node: Person): Person | null {
        if (isBranchClone(node)) return null
        if (isF(node) && isMatchingPersonId(node, targetId)) return node
        if (node.linkedSpouse) {
          const linked = findSameTreePerson(node.linkedSpouse)
          if (linked) return linked
        }
        for (const child of node.children) {
          const found = findSameTreePerson(child)
          if (found) return found
        }
        return null
      }

      return findSameTreePerson(root)
    }
    return null
  }

  const clean = wife.trim()
  const matchId = clean.match(/F\d{3,}/i)?.[0]?.toUpperCase()
  if (matchId) {
    const person = findPerson(root, matchId)
    if (person && isF(person)) return person
    for (const otherRoot of getAllKnownCachedRoots()) {
      const op = findPerson(otherRoot, matchId)
      if (op && isF(op)) return op
    }
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
  if (partial) return partial

  // Fallback: search females across other roots
  for (const otherRoot of getAllKnownCachedRoots()) {
    const ofemales = collectFemales(otherRoot)
    const oexact = ofemales.find((f) => normalizeArabic(f.name) === normInput)
    if (oexact) return oexact
  }

  return null
}

export function wifeDisplayName(wife: Wife, root: Person): string {
  if (wife.type === 'tree') {
    const linked = resolveWife(wife, root)
    if (linked) return cleanLineageText(displayPersonName(linked.name))
    if (wife.personName) return cleanLineageText(displayPersonName(wife.personName))
    if (wife.lineageLabel) {
      const first = cleanLineageText(wife.lineageLabel).split(/\s+(?:بنت|بن)\s+/)[0]
      if (first) return displayPersonName(first)
    }
    return wife.personId
  }
  return cleanLineageText(wife.name?.trim() || 'زوجة')
}

export function wifeShortLabel(wife: Wife, root: Person): string {
  if (typeof (wife as unknown) === 'string') {
    return wife as unknown as string
  }
  if (!wife) return ''
  if (wife.type === 'tree') {
    const linked = resolveWife(wife, root)
    if (linked) {
      const displayId = linked.branchMeta?.originalId || linked.id
      const isCrossTree = Boolean(
        wife.treeId || (linked.branchMeta && linked.branchMeta.type !== 'main'),
      )
      const treeLabel = wife.treeName || linked.branchMeta?.treeName
      // A cross-tree wife's code is only unique inside her own tree; showing a
      // bare code here collides with the same-coded local woman. Show the
      // source tree instead.
      if (isCrossTree && treeLabel) return `${linked.name} — ${treeLabel}`
      return `${linked.name} (${displayId})`
    }
    if (wife.personName) {
      const fromTree = wife.treeName ? ` [من: ${wife.treeName}]` : ''
      return `${wife.personName}${fromTree} (${wife.personId})`
    }
    const fromTree = wife.treeName ? ` [من: ${wife.treeName}]` : ''
    return `من الشجرة · ${wife.personId}${fromTree}`
  }
  const family = wife.family ? ` · ${wife.family}` : ''
  return `${wife.name || 'زوجة'}${family}`
}

/**
 * Strips all tree provenance annotations like [من شجرة: ...] or (شجرة ...)
 * so that lineages are clean, authentic Arabic genealogical texts.
 */
export function cleanLineageText(text: string): string {
  if (!text) return ''
  return text
    .replace(/\s*\[\s*(?:من\s+)?(?:شجرة:?\s*)?[^\]]+\]/gi, '')
    .replace(/\s*\(\s*(?:من\s+)?(?:شجرة:?\s*)[^)]+\)/gi, '')
    .replace(/\s*\(\s*شجرة\s+[^)]+\)/gi, '')
    .replace(/\s*\(شجرة[^)]+\)/gi, '')
    .replace(/\s*\[من[^\]]+\]/gi, '')
    .replace(/\s*\(من[^)]+\)/gi, '')
    .replace(/\s*\[شجرة[^\]]+\]/gi, '')
    .trim()
}

/**
 * Strips redundant prefixes from tree or branch names (e.g. "شجرة حبيب الله" -> "حبيب الله")
 */
export function cleanBranchOrTreeTitle(title: string): string {
  if (!title) return ''
  return title
    .replace(/^السجل الموحد (?:لنسب|لعائلة) آل\s+/i, '')
    .replace(/^سجل (?:نسب|عائلة) آل\s+/i, '')
    .replace(/(?:^|\s)شجرة(?:\s+|$)/gi, ' ')
    .replace(/\s*\(شجرة[^)]*\)/gi, '')
    .replace(/\s*\[شجرة[^\]]*\]/gi, '')
    .replace(/^آل\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Formats a person or ancestor name cleanly.
 */
export function displayPersonName(name: string): string {
  if (!name) return ''
  return cleanLineageText(name.trim())
}

function formatWifeLineagePath(path: Person[], minAncestors: number = 6): string {
  const selfNode = path[path.length - 1]
  const ancestors = path.slice(0, -1).reverse().filter((p) => p.id !== '__COMMON_ROOT__')
  const takeCount = Math.min(ancestors.length, Math.max(minAncestors, 4))
  const chosen = ancestors.slice(0, takeCount)
  const parts = [cleanLineageText(selfNode.name)]
  chosen.forEach((anc, idx) => {
    parts.push(idx === 0 ? 'بنت' : 'بن', cleanLineageText(anc.name))
  })
  return cleanLineageText(parts.join(' '))
}

export function wifeLineageFullLabel(
  wife: Wife,
  root: Person,
  minAncestors: number = 6,
): string {
  if (!wife) return ''
  if (wife.type === 'tree') {
    const targetId = wife.personId

    // 1. If she has a pre-computed lineage label, use it directly!
    if (wife.lineageLabel && wife.lineageLabel.trim()) {
      return cleanLineageText(wife.lineageLabel)
    }

    // 2. Search in wife's own source tree first to wire her to her biological ancestors
    const targetTreeId = wife.treeId
    const sourceRoot = targetTreeId ? getCachedTreeRoot(targetTreeId) : null
    if (sourceRoot && targetId) {
      const sourcePath = findPath(sourceRoot, targetId)
      if (sourcePath.length > 1) {
        return formatWifeLineagePath(sourcePath, minAncestors)
      }
    }

    // 3. Resolve inside root (handles current tree and connected unified branches)
    const linked = resolveWife(wife, root)
    if (linked) {
      const rootPath = findPath(root, linked.id)
      if (rootPath.length > 1) {
        return formatWifeLineagePath(rootPath, minAncestors)
      }
      if (linked.branchMeta?.treeId) {
        const bRoot = getCachedTreeRoot(linked.branchMeta.treeId)
        if (bRoot) {
          const bPath = findPath(bRoot, linked.branchMeta.originalId || linked.id)
          if (bPath.length > 1) {
            return formatWifeLineagePath(bPath, minAncestors)
          }
        }
      }
      const fl = getFemaleFullLineage(root, linked.id)
      if (fl && fl !== linked.id && fl !== linked.name) {
        return cleanLineageText(fl)
      }
      return cleanLineageText(linked.name)
    }

    // 4. Last-resort search across cached roots — only for a same-tree wife.
    // For a cross-tree wife this would match a same-coded woman from another
    // family, so her own source-tree lookup above is the only valid one.
    if (!targetTreeId) {
      for (const r of getAllKnownCachedRoots()) {
        const found = findPerson(r, targetId)
        if (found) {
          const foundPath = findPath(r, found.id)
          if (foundPath.length > 1) {
            return formatWifeLineagePath(foundPath, minAncestors)
          }
          return cleanLineageText(found.name)
        }
      }
    }

    // 5. Query getFemaleFullLineage across roots
    if (targetId) {
      const fl = getFemaleFullLineage(root, targetId)
      if (fl && fl !== targetId) {
        return cleanLineageText(fl)
      }
    }

    if (wife.personName) {
      return cleanLineageText(wife.personName)
    }

    return targetId || 'زوجة'
  }

  // External wife
  const name = cleanLineageText(wife.name?.trim() || 'زوجة')
  const details: string[] = []
  if (wife.family && wife.family.trim()) {
    details.push(cleanLineageText(wife.family.trim()))
  }
  if (wife.tribute && wife.tribute.trim()) {
    const t = cleanLineageText(wife.tribute.trim())
    if (!details.some((d) => d === t || d.includes(t) || t.includes(d))) {
      details.push(t)
    }
  }
  if (details.length > 0) {
    return `${name} · ${details.join(' · ')}`
  }
  return name
}

export function findWifeByMotherKey(
  father: Person,
  motherKey: unknown,
): Wife | null {
  if (!motherKey || !Array.isArray(father.wives) || father.wives.length === 0) return null

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
    if (!targetId && targetName) targetId = targetName
    if (!targetName && targetId) targetName = targetId
  } else if (typeof motherKey === 'string') {
    targetId = motherKey.trim()
    targetName = motherKey.trim()
  }

  // 1. Match by wife.id
  if (targetId) {
    const byId = father.wives.find((wife) => wife.id === targetId)
    if (byId) return byId
  }

  // 2. Match by personId or union id
  if (targetId || targetName) {
    const key = targetId || targetName
    const byPersonId = father.wives.find((wife) => {
      if (wife.type === 'tree') {
        return (
          wife.personId === key ||
          wife.id === key ||
          (wife.personName && wife.personName === key)
        )
      }
      return wife.id === key || wife.name === key
    })
    if (byPersonId) return byPersonId
  }

  // 3. Fallback partial/name matching
  if (targetName) {
    const norm = normalizeArabic(targetName)
    const byName = father.wives.find((wife) => {
      if (wife.type === 'external') {
        return (
          normalizeArabic(wife.name) === norm ||
          (wife.family && normalizeArabic(wife.family) === norm)
        )
      }
      return wife.personName ? normalizeArabic(wife.personName) === norm : false
    })
    if (byName) return byName
  }

  return null
}

export function motherDisplayLabel(
  child: Person,
  father: Person | null,
  root: Person,
): string {
  let motherVal: unknown = child.mother

  // If child has no explicit mother assigned, but father has exactly ONE wife,
  // then the child's mother is unambiguously that single wife!
  if (!motherVal && father && Array.isArray(father.wives) && father.wives.length === 1) {
    motherVal = father.wives[0].id
  }

  if (!motherVal) return ''

  if (father) {
    const wife = findWifeByMotherKey(father, motherVal)
    if (wife) return wifeDisplayName(wife, root)
  }

  // If motherVal matches a person ID in the tree directly
  if (typeof motherVal === 'string' && root) {
    const trimmed = motherVal.trim()
    const p = findPerson(root, trimmed)
    if (p) return displayPersonName(p.name)
    for (const otherRoot of getAllKnownCachedRoots()) {
      const op = findPerson(otherRoot, trimmed)
      if (op) return displayPersonName(op.name)
    }
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
      const parts: string[] = [displayPersonName(node.name)]
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const sep = i === ancestors.length - 1 ? 'بنت' : 'بن'
        parts.push(sep, displayPersonName(ancestors[i].name))
      }
      result.push({ person: node, father, lineageLabel: cleanLineageText(parts.join(' ')) })
    }
    for (const child of node.children) walk(child, [...ancestors, node])
  }

  walk(root, [])
  return result
}

/** Returns the full patronymic label for a single female by id. */
export function getFemaleFullLineage(root: Person, femaleId: string): string {
  const all = collectFemalesWithLineage(root)
  const found = all.find((f) => f.person.id === femaleId)?.lineageLabel
  if (found) return found
  for (const otherRoot of getAllKnownCachedRoots()) {
    const oAll = collectFemalesWithLineage(otherRoot)
    const oFound = oAll.find((f) => f.person.id === femaleId || f.person.branchMeta?.originalId === femaleId)?.lineageLabel
    if (oFound) return oFound
  }
  return femaleId
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
  commonFatherName?: string,
): UnifiedTreeResult {
  if (!connectedBranches || connectedBranches.length === 0) {
    return {
      root: mainRoot,
      branchCount: 0,
      connectedTreeIds: [mainTreeId],
      isUnified: false,
    }
  }

  // Codes that belong to each linked branch. A wife with no treeId is only
  // assumed to belong to the branch when her code exists in that branch;
  // otherwise she is a cross-tree wife and must keep resolving outside it.
  const localIdsByTree = new Map<string, Set<string>>()
  for (const b of connectedBranches) {
    const ids = new Set<string>()
    const collect = (p: Person) => {
      ids.add(p.id.toUpperCase().trim())
      for (const child of p.children) collect(child)
    }
    if (b.state?.root) collect(b.state.root)
    localIdsByTree.set(b.id, ids)
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
      wives: person.wives.map((w) => ({
        ...w,
        // In a unified view, a wife that belongs to a linked branch must keep
        // that branch's tree id so her tag resolves inside the branch instead
        // of matching a same-coded woman in the main tree.
        treeId:
          w.type === 'tree' && meta.type !== 'main' && !w.treeId
            ? localIdsByTree.get(meta.treeId)?.has(w.personId.toUpperCase().trim())
              ? meta.treeId
              : undefined
            : w.type === 'tree'
              ? w.treeId
              : undefined,
      })),
      children: person.children.map((child) => cloneAndTag(child, prefix, meta)),
      linkedSpouse: person.linkedSpouse ? cloneAndTag(person.linkedSpouse, prefix, meta) : undefined,
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
    // Prevent self-linking or duplicate root inclusion
    if (b.id === mainTreeId || (b.state.root.id === mainRoot.id && b.state.root.name === mainRoot.name)) {
      continue
    }
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
        // The linked root is the husband/father (e.g. حبيب الله)!
        // Link him as the husband (linkedSpouse) of the daughter (آمنة)
        targetNode.linkedSpouse = clonedRoot

        // His children are their children descending from this marriage
        targetNode.children = [...targetNode.children, ...clonedRoot.children]

        // Tag mother on each child
        clonedRoot.children.forEach((child) => {
          if (!child.mother) {
            child.mother = targetNode.name
          }
        })

        // Ensure wife relationship is recorded on the husband
        if (!clonedRoot.wives.some((w) => w.type === 'tree' && w.personId === targetNode.id)) {
          clonedRoot.wives.push({
            id: `tw_${targetNode.id}`,
            type: 'tree',
            personId: targetNode.id,
            lineageLabel: targetNode.name,
          })
        }
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
    const trimmedCommonName = commonFatherName?.trim() || ''
    const commonFatherTitle = trimmedCommonName || 'محمد'

    const containerRoot: Person = {
      id: `__COMMON_ROOT__`,
      name: commonFatherTitle,
      gender: 'M',
      children: [clonedMain, ...brotherRoots],
      wives: [],
      mother: null,
      branchMeta: {
        treeId: mainTreeId,
        treeName: commonFatherTitle,
        type: 'main',
        isVirtualContainer: true,
        personName: commonFatherTitle,
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

export interface FemaleRelationInfo {
  husbands: Person[]
  children: Person[]
  sons: Person[]
  daughters: Person[]
}

/**
 * Computes all husbands and children (sons & daughters) for every female in the tree in a single pass.
 */
export function getAllFemalesRelations(root: Person): Map<string, FemaleRelationInfo> {
  const result = new Map<string, {
    husbands: Map<string, Person>
    children: Map<string, Person>
  }>()

  const femaleById = new Map<string, Person>()
  const femaleByOriginalId = new Map<string, Person>()

  function registerFemale(female: Person) {
    femaleById.set(female.id, female)
    femaleById.set(female.id.toUpperCase().trim(), female)
    const originalId = female.branchMeta?.originalId?.toUpperCase().trim()
    if (originalId) femaleByOriginalId.set(originalId, female)
    if (!result.has(female.id)) {
      result.set(female.id, {
        husbands: new Map(),
        children: new Map(),
      })
    }
  }

  // Pass 1: Collect all females & direct linked spouses/children
  function collect(node: Person) {
    if (node.gender === 'F') {
      registerFemale(node)
      if (node.linkedSpouse) {
        const entry = result.get(node.id)!
        entry.husbands.set(node.linkedSpouse.id, node.linkedSpouse)
      }
      if (node.children) {
        const entry = result.get(node.id)!
        node.children.forEach((c) => entry.children.set(c.id, c))
      }
    }
    if (node.children) {
      node.children.forEach(collect)
    }
  }
  collect(root)

  // Pass 2: Connect male wives and their children to the corresponding females
  function connect(node: Person) {
    if (node.gender === 'M' && node.wives && node.wives.length > 0) {
      for (const w of node.wives) {
        // ONLY link internal tree wives (external wives are outside bloodline and not nodes in this tree)
        if (w.type !== 'tree') continue

        const wifeId = w.personId?.toUpperCase().trim()
        // Fast path: most wives are already registered in this tree. Only fall
        // back to the deep cross-tree resolver for genuine branch wives.
        let targetFemale: Person | null = wifeId
          ? (femaleById.get(wifeId) ?? femaleByOriginalId.get(wifeId) ?? null)
          : null
        if (!targetFemale) targetFemale = resolveWife(w, root)

        if (!targetFemale) continue

        if (!result.has(targetFemale.id)) {
          registerFemale(targetFemale)
        }
        const entry = result.get(targetFemale.id)
        if (entry) {
          entry.husbands.set(node.id, node)

          // Map children of this male specifically to this female
          if (node.children) {
            for (const child of node.children) {
              const motherKey = child.mother ? String(child.mother).trim() : ''

              if (
                motherKey === w.id ||
                motherKey === targetFemale.id ||
                motherKey === w.personId ||
                (w.treeId && motherKey === `br_${w.treeId.slice(0, 6)}_${w.personId}`) ||
                (node.wives.length === 1 && !motherKey)
              ) {
                entry.children.set(child.id, child)
              }
            }
          }
        }
      }
    }

    if (node.children) {
      node.children.forEach(connect)
    }
  }
  connect(root)

  const finalMap = new Map<string, FemaleRelationInfo>()
  for (const [id, data] of result.entries()) {
    const husbands = Array.from(data.husbands.values())
    const children = Array.from(data.children.values())
    const sons = children.filter((c) => c.gender === 'M')
    const daughters = children.filter((c) => c.gender === 'F')
    finalMap.set(id, { husbands, children, sons, daughters })
  }

  return finalMap
}

export function getFemaleSpousesAndChildren(root: Person, female: Person): FemaleRelationInfo {
  const map = getAllFemalesRelations(root)
  return map.get(female.id) || { husbands: [], children: [], sons: [], daughters: [] }
}
