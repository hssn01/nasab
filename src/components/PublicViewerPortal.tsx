import React, { useState, useEffect, useMemo, useRef } from 'react'
import { fetchDeviceTrees, fetchTreeState } from '../db'
import type { Person, TreeMeta, TreeState, Wife } from '../types'
import {
  countPeople,
  findPath,
  findPerson,
  findWifeByMotherKey,
  motherDisplayLabel,
  resolveWife,
  wifeShortLabel,
} from '../treeUtils'
import './PublicViewerPortal.css'
import './ViewerMobileApp.css'

// ── Types ───────────────────────────────────────────────────────────────────

interface PersonWithContext {
  person: Person
  parent: Person | null
  ancestors: Person[]
  generation: number
  lineage: string
}

interface TreePosNode {
  person: Person
  x: number
  y: number
  width: number
  children: TreePosNode[]
  hasChildren: boolean
  isExpanded: boolean
}

interface MaternalInfo {
  childrenCount: number
  childrenNames: string[]
  husbandName: string
  husbandLineage?: string
}

// ── Dimensions for Visual Tree ──────────────────────────────────────────────
const CARD_WIDTH = 150
const CARD_HEIGHT = 72
const NODE_GAP = 20
const LEVEL_HEIGHT = 115

function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .toLocaleLowerCase('ar')
    .trim()
}

function getLineageChain(root: Person, targetId: string, connector = 'ولد'): string {
  const path = findPath(root, targetId)
  if (path.length === 0) return ''
  return [...path]
    .reverse()
    .map((p) => p.name)
    .join(` ${connector} `)
}

function getWifeBookDescription(wife: Wife, root: Person, connector = 'ولد'): string {
  if (wife.type === 'tree') {
    const person = resolveWife(wife, root)
    if (person) {
      const path = findPath(root, person.id)
      if (path.length > 1) {
        const chain = [...path].reverse().map((p) => p.name)
        const femaleName = chain[0]
        const ancestors = chain.slice(1).join(` ${connector} `)
        return `${femaleName} بنت ${ancestors}`
      }
      return `${person.name} (من المشجر)`
    }
    return wife.personName || wife.personId
  }
  const parts = [wife.name]
  if (wife.family) parts.push(`بنت ${wife.family}`)
  if (wife.tribute) parts.push(`(${wife.tribute})`)
  return parts.join(' ')
}

function flattenTree(root: Person, connector = 'ولد'): PersonWithContext[] {
  const list: PersonWithContext[] = []

  function traverse(
    node: Person,
    parent: Person | null,
    ancestors: Person[],
    generation: number
  ) {
    const lineage = [...ancestors, node].reverse().map((p) => p.name).join(` ${connector} `)
    list.push({
      person: node,
      parent,
      ancestors,
      generation,
      lineage,
    })

    for (const child of node.children) {
      traverse(child, node, [...ancestors, node], generation + 1)
    }
  }

  traverse(root, null, [], 0)
  return list
}

// ── Build Mothers Map (Identifies daughters who are mothers in tree) ────────

function buildMothersMap(root: Person, connector = 'ولد'): Map<string, MaternalInfo[]> {
  const map = new Map<string, MaternalInfo[]>()

  function walk(node: Person, ancestors: Person[]) {
    const fullAncestry = [...ancestors, node]
    const husbandLineage = [...fullAncestry].reverse().map((p) => p.name).join(` ${connector} `)

    if (node.gender === 'M' && node.children.length > 0) {
      const motherGroups = new Map<string, Person[]>()
      for (const child of node.children) {
        if (child.mother) {
          const list = motherGroups.get(child.mother) || []
          list.push(child)
          motherGroups.set(child.mother, list)
        }
      }

      for (const [motherKey, kids] of motherGroups.entries()) {
        const wife = findWifeByMotherKey(node, motherKey)
        let femaleId: string | null = null

        if (wife?.type === 'tree' && wife.personId) {
          const resolved = findPerson(root, wife.personId)
          if (resolved && resolved.gender === 'F') {
            femaleId = resolved.id
          }
        }

        if (femaleId) {
          const info: MaternalInfo = {
            childrenCount: kids.length,
            childrenNames: kids.map((k) => k.name),
            husbandName: node.name,
            husbandLineage,
          }
          const list = map.get(femaleId) || []
          list.push(info)
          map.set(femaleId, list)
        }
      }
    }

    for (const child of node.children) {
      walk(child, fullAncestry)
    }
  }

  walk(root, [])
  return map
}

// ── Tree Layout Calculation ────────────────────────────────────────────────

function computeTreeLayout(root: Person, expandedIds: Set<string>) {
  function getSubtreeWidth(person: Person): { pos: TreePosNode; totalWidth: number } {
    const hasChildren = person.children && person.children.length > 0
    const isExpanded = expandedIds.has(person.id)

    if (!hasChildren || !isExpanded) {
      const pos: TreePosNode = {
        person,
        x: 0,
        y: 0,
        width: CARD_WIDTH,
        children: [],
        hasChildren,
        isExpanded,
      }
      return { pos, totalWidth: CARD_WIDTH }
    }

    const childResults = person.children.map(getSubtreeWidth)
    const childrenTotalWidth =
      childResults.reduce((acc, c) => acc + c.totalWidth, 0) +
      (person.children.length - 1) * NODE_GAP
    const totalWidth = Math.max(CARD_WIDTH, childrenTotalWidth)

    const pos: TreePosNode = {
      person,
      x: 0,
      y: 0,
      width: totalWidth,
      children: childResults.map((c) => c.pos),
      hasChildren,
      isExpanded,
    }
    return { pos, totalWidth }
  }

  function assignCoords(node: TreePosNode, left: number, depth: number) {
    node.y = depth * LEVEL_HEIGHT

    if (node.children.length === 0) {
      node.x = left + node.width / 2
    } else {
      let currentLeft = left
      const childrenSum =
        node.children.reduce((acc, c) => acc + c.width, 0) +
        (node.children.length - 1) * NODE_GAP
      if (node.width > childrenSum) {
        currentLeft += (node.width - childrenSum) / 2
      }

      node.children.forEach((child) => {
        assignCoords(child, currentLeft, depth + 1)
        currentLeft += child.width + NODE_GAP
      })

      const firstChild = node.children[0]
      const lastChild = node.children[node.children.length - 1]
      node.x = (firstChild.x + lastChild.x) / 2
    }
  }

  const { pos: layoutRoot } = getSubtreeWidth(root)
  assignCoords(layoutRoot, 0, 0)

  const nodes: TreePosNode[] = []
  const links: { id: string; x1: number; y1: number; x2: number; y2: number }[] = []

  function flatten(node: TreePosNode) {
    nodes.push(node)
    node.children.forEach((child) => {
      links.push({
        id: `${node.person.id}->${child.person.id}`,
        x1: node.x,
        y1: node.y + CARD_HEIGHT,
        x2: child.x,
        y2: child.y,
      })
      flatten(child)
    })
  }

  flatten(layoutRoot)

  let minX = Infinity
  let maxX = -Infinity
  let maxY = 0

  nodes.forEach((n) => {
    minX = Math.min(minX, n.x - CARD_WIDTH / 2)
    maxX = Math.max(maxX, n.x + CARD_WIDTH / 2)
    maxY = Math.max(maxY, n.y + CARD_HEIGHT)
  })

  const bounds = {
    minX: isFinite(minX) ? minX : 0,
    maxX: isFinite(maxX) ? maxX : CARD_WIDTH,
    maxY: maxY || CARD_HEIGHT,
    width: Math.max(CARD_WIDTH, maxX - minX),
    height: Math.max(CARD_HEIGHT, maxY),
  }

  return { nodes, links, bounds }
}

// ── Family Register Data Structures ────────────────────────────────────────

interface FamilyEntry {
  person: Person
  lineage: Person[]
  sons: Person[]
  daughters: Person[]
  wives: Wife[]
  hasDescendants: boolean
}

function collectFamilyEntries(root: Person): FamilyEntry[] {
  const entries: FamilyEntry[] = []

  function walk(node: Person, ancestors: Person[]) {
    const path = [...ancestors, node]

    if (node.gender === 'M') {
      const sons = node.children.filter((c) => c.gender === 'M')
      const daughters = node.children.filter((c) => c.gender === 'F')
      const hasDescendants = sons.some((s) => s.children.length > 0 || s.wives.length > 0)
      entries.push({
        person: node,
        lineage: path,
        sons,
        daughters,
        wives: node.wives || [],
        hasDescendants,
      })
    }

    for (const child of node.children) {
      walk(child, path)
    }
  }

  walk(root, [])
  return entries
}

// =============================================================================
// Main Public Viewer Portal Component
// =============================================================================

export function PublicViewerPortal({ initialTreeId }: { initialTreeId?: string | null }) {
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search)
    return initialTreeId || params.get('t') || params.get('tree') || null
  })

  const [treeState, setTreeState] = useState<TreeState | null>(null)
  const [loadingTree, setLoadingTree] = useState(false)
  const [activeTab, setActiveTab] = useState<'tree' | 'search' | 'register'>('tree')
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // Listen to popstate
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search)
      const t = params.get('t') || params.get('tree') || null
      setSelectedTreeId(t)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Load Tree Data when selectedTreeId changes
  useEffect(() => {
    if (!selectedTreeId) {
      setTreeState(null)
      return
    }

    async function load() {
      setLoadingTree(true)
      try {
        const state = await fetchTreeState(selectedTreeId!)
        if (state) {
          setTreeState(state)
          const params = new URLSearchParams(window.location.search)
          const personId = params.get('person')
          if (personId && state.root) {
            const found = findPerson(state.root, personId)
            if (found) setSelectedPerson(found)
          }
        }
      } catch (err) {
        console.error('Failed to load tree state:', err)
      } finally {
        setLoadingTree(false)
      }
    }
    load()
  }, [selectedTreeId])

  function handleSelectTree(id: string) {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'viewer')
    url.searchParams.set('t', id)
    history.pushState({}, '', url.toString())
    setSelectedTreeId(id)
    setSelectedPerson(null)
  }

  function handleBackToCatalog() {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'viewer')
    url.searchParams.delete('t')
    url.searchParams.delete('tree')
    url.searchParams.delete('person')
    history.pushState({}, '', url.toString())
    setSelectedTreeId(null)
    setTreeState(null)
    setSelectedPerson(null)
  }

  function showToast(msg: string) {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 2500)
  }

  function handleShare(personId?: string) {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'viewer')
    if (selectedTreeId) url.searchParams.set('t', selectedTreeId)
    if (personId) url.searchParams.set('person', personId)
    navigator.clipboard.writeText(url.toString())
    showToast('تم نسخ الرابط العام بنجاح!')
  }

  // If no tree is selected, show Public Catalog Landing Page
  if (!selectedTreeId) {
    return <PublicTreesCatalog onSelectTree={handleSelectTree} />
  }

  if (loadingTree) {
    return (
      <div className="v-loading" dir="rtl">
        <div className="v-spinner" />
        <p>جارٍ تحميل بيانات الشجرة للزائر…</p>
      </div>
    )
  }

  if (!treeState?.root) {
    return (
      <div className="v-loading" dir="rtl">
        <p>لم يتم العثور على شجرة بالنسب المحددة أو أنها غير متاحة حالياً.</p>
        <button
          type="button"
          className="pv-back-to-catalog-btn"
          style={{ marginTop: '16px' }}
          onClick={handleBackToCatalog}
        >
          ← العودة إلى قائمة المشجرات
        </button>
      </div>
    )
  }

  const root = treeState.root
  const allPeople = flattenTree(root)
  const mothersMap = buildMothersMap(root)

  return (
    <div className="pv-root" dir="rtl">
      {/* ── Top Header Bar ── */}
      <header className="pv-header">
        <div className="pv-header-start">
          <button
            type="button"
            className="pv-back-to-catalog-btn"
            onClick={handleBackToCatalog}
            title="الرجوع إلى دليل جميع المشجرات العائلية"
          >
            ← كل المشجرات
          </button>

          <div className="pv-header-title-box">
            <h1 className="pv-header-title">شجرة آل {root.name}</h1>
            <span className="pv-header-counter-pill">{allPeople.length} فرد</span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="pv-nav-tabs" role="tablist">
          <button
            type="button"
            className={`pv-nav-tab ${activeTab === 'tree' ? 'active' : ''}`}
            onClick={() => setActiveTab('tree')}
            title="المشجر البصري التفاعلي"
          >
            🌳 المشجّر
          </button>
          <button
            type="button"
            className={`pv-nav-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
            title="دليل الأسماء والبحث"
          >
            🔍 البحث ({allPeople.length})
          </button>
          <button
            type="button"
            className={`pv-nav-tab ${activeTab === 'register' ? 'active' : ''}`}
            onClick={() => setActiveTab('register')}
            title="السجل العائلي المرتب وطباعة PDF"
          >
            📜 السجل والطباعة PDF
          </button>
        </nav>

        <div className="pv-header-actions">
          <button
            type="button"
            className="pv-btn-share"
            onClick={() => handleShare(selectedPerson?.id)}
            title="مشاركة رابط المشجر للزوار"
          >
            🔗 مشاركة
          </button>
        </div>
      </header>

      {/* ── Tab 1: Interactive Visual Tree ── */}
      {activeTab === 'tree' && (
        <InteractiveTreeCanvas
          root={root}
          selectedPerson={selectedPerson}
          onSelectPerson={(p) => setSelectedPerson(p)}
        />
      )}

      {/* ── Tab 2: Search Directory ── */}
      {activeTab === 'search' && (
        <SearchDirectoryTab
          allPeople={allPeople}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          mothersMap={mothersMap}
          onSelectPerson={(p) => {
            setSelectedPerson(p)
            setActiveTab('tree')
          }}
          onOpenCard={(p) => setSelectedPerson(p)}
        />
      )}

      {/* ── Tab 3: Structured Family Register & PDF Export ── */}
      {activeTab === 'register' && (
        <StructuredFamilyRegisterPDFView
          root={root}
          treeName={treeState.root.name}
          mothersMap={mothersMap}
        />
      )}

      {/* ── Person Bottom Sheet Profile ── */}
      {selectedPerson && (
        <PersonBottomSheet
          person={selectedPerson}
          root={root}
          mothersMap={mothersMap}
          onClose={() => setSelectedPerson(null)}
          onSelectPerson={(p) => setSelectedPerson(p)}
          onShare={() => handleShare(selectedPerson.id)}
        />
      )}

      {/* Toast */}
      {toastMsg && <div className="v-toast">{toastMsg}</div>}
    </div>
  )
}

// =============================================================================
// Public Trees Catalog Landing Page (No Edit / Delete Buttons)
// =============================================================================

function PublicTreesCatalog({ onSelectTree }: { onSelectTree: (id: string) => void }) {
  const [trees, setTrees] = useState<TreeMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const list = await fetchDeviceTrees()
        setTrees(list)
      } catch (err) {
        console.error('Failed to load public trees:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const filtered = useMemo(() => {
    if (!filter.trim()) return trees
    const q = searchable(filter)
    return trees.filter(
      (t) =>
        searchable(t.name).includes(q) ||
        (t.rootAncestor && searchable(t.rootAncestor).includes(q))
    )
  }, [trees, filter])

  function formatDate(iso: string) {
    try {
      return new Intl.DateTimeFormat('ar-SA', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(new Date(iso))
    } catch {
      return iso
    }
  }

  return (
    <div className="pv-root" dir="rtl">
      <header className="pv-header">
        <div className="pv-brand-badge">
          <span>نَسَب</span>
          <span className="pv-brand-pill">بوابة الزوار</span>
        </div>
        <div className="pv-header-actions">
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            استعراض وبحث الأنساب
          </span>
        </div>
      </header>

      <main className="pv-catalog-container">
        <div className="pv-catalog-hero">
          <div className="pv-catalog-hero-pill">🌳 المشجرات العائلية الموثقة</div>
          <h1 className="pv-catalog-title">دليل مشجّرات الأنساب</h1>
          <p className="pv-catalog-desc">
            بوابة رقمية مخصصة للزوار وأفراد العائلة لاستعراض شجرات النسب، والبحث عن الأفراد وسلاسل
            القرابة، وتصدير السجلات العائلية الرسمية بصيغة PDF قابلة للطباعة.
          </p>

          <div className="pv-catalog-search-bar">
            <span className="pv-catalog-search-icon">🔍</span>
            <input
              type="search"
              className="pv-catalog-search-input"
              placeholder="ابحث باسم الشجرة أو الجد الأعلى…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="v-loading" style={{ height: '240px' }}>
            <div className="v-spinner" />
            <p>جارٍ تحميل دليل المشجرات…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="v-empty" style={{ margin: '40px auto', maxWidth: '400px' }}>
            {filter ? 'لا توجد مشجرات مطابقة للبحث' : 'لا توجد مشجرات مسجلة حتى الآن'}
          </div>
        ) : (
          <div className="pv-catalog-grid">
            {filtered.map((tree) => {
              const isBranch = Boolean(tree.linkedFrom)
              return (
                <article
                  key={tree.id}
                  className="pv-tree-card"
                  onClick={() => onSelectTree(tree.id)}
                >
                  <div>
                    <div className="pv-tree-card-header">
                      <h2 className="pv-tree-card-title">{tree.name}</h2>
                    </div>

                    {isBranch && (
                      <div className="pv-tree-branch-badge">
                        🌿 {tree.linkedFrom?.type === 'daughter-branch'
                          ? 'فرع بنت'
                          : tree.linkedFrom?.type === 'brother-branch'
                          ? 'فرع أخ'
                          : 'فرع مرتبط'}
                        {tree.linkedFrom?.personName ? ` (${tree.linkedFrom.personName})` : ''}
                      </div>
                    )}

                    {tree.rootAncestor && (
                      <p className="pv-tree-progenitor">
                        الجد الأعلى: <strong>{tree.rootAncestor}</strong>
                      </p>
                    )}
                  </div>

                  <div className="pv-tree-card-footer">
                    <span className="pv-tree-date">
                      🕒 {formatDate(tree.updated_at)}
                    </span>
                    <button
                      type="button"
                      className="pv-tree-open-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectTree(tree.id)
                      }}
                    >
                      استعراض المشجر ←
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

// =============================================================================
// Search Directory Tab
// =============================================================================

function SearchDirectoryTab({
  allPeople,
  searchQuery,
  setSearchQuery,
  mothersMap,
  onSelectPerson,
  onOpenCard,
}: {
  allPeople: PersonWithContext[]
  searchQuery: string
  setSearchQuery: (q: string) => void
  mothersMap: Map<string, MaternalInfo[]>
  onSelectPerson: (p: Person) => void
  onOpenCard: (p: Person) => void
}) {
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return allPeople
    const q = searchable(searchQuery)
    return allPeople.filter(
      (item) =>
        searchable(item.person.name).includes(q) ||
        searchable(item.lineage).includes(q)
    )
  }, [allPeople, searchQuery])

  return (
    <div className="pv-search-container">
      <div className="pv-search-input-box">
        <span className="pv-catalog-search-icon">🔍</span>
        <input
          type="search"
          className="pv-search-input"
          placeholder="ابحث باسم الشخص أو سلالة النسب…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus
        />
        {searchQuery && (
          <button
            type="button"
            className="pv-search-clear"
            onClick={() => setSearchQuery('')}
          >
            ✕
          </button>
        )}
      </div>

      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        {searchQuery
          ? `نتائج البحث: تم العثور على ${filtered.length} شخص`
          : `إجمالي المقيدين في الشجرة: ${allPeople.length} فرد`}
      </p>

      <div className="pv-people-list">
        {filtered.length === 0 ? (
          <div className="v-empty">لا توجد نتائج مطابقة لبحثك</div>
        ) : (
          filtered.map(({ person, lineage }) => {
            const isMale = person.gender === 'M'
            const maternal = mothersMap.get(person.id)

            return (
              <div
                key={person.id}
                className={`pv-person-row ${isMale ? 'male' : 'female'}`}
                onClick={() => onSelectPerson(person)}
              >
                <div className="pv-person-row-info">
                  <div className="pv-person-name-line">
                    <span className="pv-person-name">{person.name}</span>
                    <span
                      style={{
                        fontSize: '11px',
                        color: isMale ? 'var(--male)' : 'var(--female)',
                        fontWeight: 600,
                      }}
                    >
                      {isMale ? 'ذكر' : 'أنثى'}
                    </span>
                    {person.children.length > 0 && (
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        ({person.children.length} من الذرية)
                      </span>
                    )}
                    {!isMale && maternal && maternal.length > 0 && (
                      <span className="pv-mother-tag-badge">
                        🌸 أم لـ: {maternal[0].childrenNames.slice(0, 2).join('، ')}
                        {maternal[0].childrenNames.length > 2 ? '…' : ''}
                      </span>
                    )}
                  </div>
                  <div className="pv-person-lineage" title={lineage}>
                    {lineage}
                  </div>
                </div>

                <button
                  type="button"
                  className="v-card-action"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenCard(person)
                  }}
                >
                  البطاقة ‹
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Structured Family Register & PDF Export View
// =============================================================================

function StructuredFamilyRegisterPDFView({
  root,
  treeName,
  mothersMap,
}: {
  root: Person
  treeName: string
  mothersMap: Map<string, MaternalInfo[]>
}) {
  const [styleMode, setStyleMode] = useState<'book' | 'certificate'>('book')
  const [connector, setConnector] = useState<'ولد' | 'بن'>('ولد')

  const counts = useMemo(() => countPeople(root), [root])
  const familyEntries = useMemo(() => collectFamilyEntries(root), [root])
  const activeEntries = useMemo(
    () =>
      familyEntries.filter(
        (e) =>
          e.sons.length > 0 ||
          e.daughters.length > 0 ||
          (e.wives && e.wives.length > 0)
      ),
    [familyEntries]
  )

  const currentDate = useMemo(() => {
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date())
  }, [])

  const maxDepth = useMemo(() => {
    let max = 0
    familyEntries.forEach((e) => {
      if (e.lineage.length > max) max = e.lineage.length
    })
    return max
  }, [familyEntries])

  return (
    <div className="pv-register-wrapper">
      {/* Screen-Only Toolbar */}
      <div className="pv-register-toolbar">
        <div>
          <span className="pv-register-toolbar-title">
            {styleMode === 'book'
              ? '📖 سجل الأنساب (نسق الكتاب المحظري التراثي البسيط)'
              : '📜 وثيقة النسب المزخرفة'}
          </span>
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
            مُعدّ ومُهيأ للطباعة المباشرة وحفظ الـ PDF بهيكلية كتب الأنساب التراثية
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Connector Toggle: ولد / بن */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'var(--bg-raised)',
              padding: '2px 6px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '2px' }}>
              الرابط:
            </span>
            <button
              type="button"
              className={`compact-button ${connector === 'ولد' ? 'primary' : ''}`}
              style={{ padding: '2px 8px', fontSize: '12px' }}
              onClick={() => setConnector('ولد')}
            >
              ولد
            </button>
            <button
              type="button"
              className={`compact-button ${connector === 'بن' ? 'primary' : ''}`}
              style={{ padding: '2px 8px', fontSize: '12px' }}
              onClick={() => setConnector('بن')}
            >
              بن
            </button>
          </div>

          {/* Style Mode Switcher */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'var(--bg-raised)',
              padding: '2px 6px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            <button
              type="button"
              className={`compact-button ${styleMode === 'book' ? 'primary' : ''}`}
              style={{ padding: '2px 10px', fontSize: '12px' }}
              onClick={() => setStyleMode('book')}
              title="النسق التراثي البسيط المستوحى من كتب ومخطوطات الأنساب القديمة"
            >
              📖 نسق الكتاب
            </button>
            <button
              type="button"
              className={`compact-button ${styleMode === 'certificate' ? 'primary' : ''}`}
              style={{ padding: '2px 10px', fontSize: '12px' }}
              onClick={() => setStyleMode('certificate')}
              title="نسق الوثيقة العائلية المذهبة"
            >
              📜 وثيقة مذهبة
            </button>
          </div>

          <button
            type="button"
            className="pv-btn-print-action"
            onClick={() => window.print()}
          >
            🖨️ طباعة / حفظ كملف PDF
          </button>
        </div>
      </div>

      {/* ── Option A: Modern Heritage Designed Book Page ── */}
      {styleMode === 'book' ? (
        <article className="pv-book-page" dir="rtl">
          <header className="pv-book-header">
            <p className="pv-book-basmala">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</p>
            <p className="pv-book-salawat">صلّى الله على نبيّه الكريم</p>
            <h1 className="pv-book-main-title">
              سجل ومشجّر نسب آل {treeName || root.name}
            </h1>
            <div className="pv-book-progenitor-badge">
              <span>الجد الأعلى والمؤسس:</span>
              <strong>{root.name}</strong>
            </div>
          </header>

          <main>
            {activeEntries.map((entry) => {
              const { person, lineage, sons, daughters, wives } = entry
              const ancestorPath = lineage.slice(0, -1)
              const generation = lineage.length
              const fatherLineage = [...lineage]
                .reverse()
                .map((p) => p.name)
                .join(` ${connector} `)

              return (
                <section key={person.id} className="pv-book-entry">
                  {/* Branch Card Header */}
                  <div className="pv-book-branch-header">
                    <div className="pv-book-branch-title-wrap">
                      <span className="pv-book-branch-mark">❖</span>
                      <h2 className="pv-book-branch-title">
                        أولاد <span className="pv-book-person-name">{person.name}</span>
                        {ancestorPath.length > 0 && (
                          <span className="pv-book-ancestor-chain">
                            {' '}{connector} {[...ancestorPath].reverse().map((p) => p.name).join(` ${connector} `)} :
                          </span>
                        )}
                      </h2>
                    </div>
                    <div className="pv-book-branch-meta">
                      <span className="pv-book-gen-pill">الجيل {generation.toLocaleString('ar')}</span>
                      {sons.length > 0 && (
                        <span className="pv-book-count-pill">{sons.length.toLocaleString('ar')} ذكور</span>
                      )}
                      {daughters.length > 0 && (
                        <span className="pv-book-count-pill female">{daughters.length.toLocaleString('ar')} إناث</span>
                      )}
                    </div>
                  </div>

                  {/* Sons Block */}
                  {sons.length > 0 && (
                    <div className="pv-book-subgroup">
                      <div className="pv-book-subhead">
                        <span className="pv-book-subhead-sym">=</span> الأبناء الذكور :
                      </div>
                      <div className="pv-book-sons-flow">
                        {sons.map((s, i) => {
                          const isLeaf = s.children.length === 0
                          let sonStatus = ''
                          if (isLeaf) {
                            sonStatus = s.wives && s.wives.length > 0 ? 'متزوج (لم يعقب بعد)' : 'لم يعقب بعد'
                          }
                          return (
                            <div key={s.id} className="pv-book-son-item">
                              <span className="pv-book-item-num">{(i + 1).toLocaleString('ar')}-</span>
                              <span className="pv-book-item-name">{s.name}</span>
                              {sonStatus && (
                                <span className="pv-book-item-note">({sonStatus})</span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Daughters Block */}
                  {daughters.length > 0 && (
                    <div className="pv-book-subgroup">
                      <div className="pv-book-subhead">
                        <span className="pv-book-subhead-sym">-</span> البنات وتوثيق الأمهات :
                      </div>
                      <div className="pv-book-daughters-flow">
                        {daughters.map((d, i) => {
                          const maternal = mothersMap.get(d.id)
                          return (
                            <div key={d.id} className="pv-book-daughter-row">
                              <div className="pv-book-daughter-lead">
                                <span className="pv-book-item-num female">{(i + 1).toLocaleString('ar')}-</span>
                                <span className="pv-book-item-name">{d.name}</span>
                              </div>

                              {maternal && maternal.length > 0 && (
                                <div className="pv-book-maternal-block">
                                  {maternal.map((m, mIdx) => (
                                    <div key={mIdx} className="pv-book-maternal-line">
                                      <span className="pv-book-maternal-prefix">
                                        {mIdx > 0 ? '؛ وهي كذلك أم :' : 'وهي أم :'}
                                      </span>{' '}
                                      <span className="pv-book-maternal-kids">
                                        ({m.childrenNames.join(' و ')})
                                      </span>{' '}
                                      <span className="pv-book-maternal-rel">أولاد</span>{' '}
                                      <span className="pv-book-maternal-husband">
                                        {m.husbandLineage || m.husbandName}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Mother / Wives Strip */}
                  {wives && wives.length > 0 && (
                    <div className="pv-book-wife-row">
                      <span className="pv-book-wife-bullet">◈</span>
                      <div className="pv-book-wife-content">
                        {wives.length === 1 ? (
                          <p className="pv-book-wife-p">
                            أما أم أولاد <strong>{fatherLineage}</strong> فهي{' '}
                            <strong className="pv-book-wife-target">
                              {getWifeBookDescription(wives[0], root, connector)}
                            </strong> .
                          </p>
                        ) : (
                          <div className="pv-book-wife-multi">
                            {wives.map((w, wIdx) => {
                              const wDesc = getWifeBookDescription(w, root, connector)
                              const kids = [...sons, ...daughters].filter((c) => {
                                if (!c.mother) return false
                                return (
                                  c.mother === w.id ||
                                  c.mother === (w.type === 'tree' ? w.personId : w.name)
                                )
                              })
                              if (kids.length > 0) {
                                const kidNames = kids.map((k) => k.name).join(' و ')
                                return (
                                  <p key={wIdx} className="pv-book-wife-p">
                                    أما أم أولاده (<strong>{kidNames}</strong>) فهي{' '}
                                    <strong className="pv-book-wife-target">{wDesc}</strong> .
                                  </p>
                                )
                              }
                              return (
                                <p key={wIdx} className="pv-book-wife-p">
                                  ومن زوجاته: <strong className="pv-book-wife-target">{wDesc}</strong> .
                                </p>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )
            })}
          </main>
        </article>
      ) : (
        /* ── Option B: Bordered Certificate Document ── */
        <article className="pv-tribute-paper">
          <div className="pv-doc-outer-border">
            <div className="pv-doc-inner-border">
              {/* Document Header */}
              <header className="pv-doc-header">
                <p className="pv-doc-basmala">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</p>
                <div className="pv-doc-badge">وثيقة وسجل نسب عائلي رسمي</div>
                <h1 className="pv-doc-title">مشجّر وسجل نسب آل {treeName || root.name}</h1>
                <p className="pv-doc-progenitor">
                  الجد الأعلى والمؤسس: <strong>{root.name}</strong>
                </p>
                <div className="pv-doc-divider">✦ ✦ ✦</div>
                <p style={{ fontSize: '13px', color: '#7a6a55', margin: '4px 0' }}>
                  «تعلّموا من أنسابكم ما تصلون به أرحامكم» — حُررت هذه الوثيقة توثيقاً للسلالة وحفظاً للأواصر
                </p>
              </header>

              {/* Document Statistics */}
              <section className="pv-doc-stats">
                <div>
                  <div className="pv-stat-num">{counts.males.toLocaleString('ar')}</div>
                  <div className="pv-stat-lbl">الذكور</div>
                </div>
                <div>
                  <div className="pv-stat-num">{counts.females.toLocaleString('ar')}</div>
                  <div className="pv-stat-lbl">الإناث</div>
                </div>
                <div>
                  <div className="pv-stat-num">{(counts.males + counts.females).toLocaleString('ar')}</div>
                  <div className="pv-stat-lbl">المجموع الكلي</div>
                </div>
                <div>
                  <div className="pv-stat-num">{maxDepth.toLocaleString('ar')} أجيال</div>
                  <div className="pv-stat-lbl">عمق الأجيال</div>
                </div>
              </section>

              {/* Hierarchical Register Entries */}
              <section className="pv-register-entries">
                {activeEntries.map((entry) => {
                  const { person, lineage, sons, daughters, wives } = entry
                  const ancestorPath = lineage.slice(0, -1)
                  const generation = lineage.length

                  return (
                    <div key={person.id} className="pv-entry-card">
                      {/* Ancestry Lineage Breadcrumb Chain */}
                      {ancestorPath.length > 0 && (
                        <p className="pv-entry-breadcrumb">
                          <span>سلسلة النسب: </span>
                          <span className="pv-entry-breadcrumb-chain">
                            {[...ancestorPath]
                              .reverse()
                              .map((p) => p.name)
                              .join(` ${connector} `)}
                          </span>
                        </p>
                      )}

                      {/* Father Header */}
                      <div className="pv-entry-father-row">
                        <span className="pv-gen-badge">الجيل {generation.toLocaleString('ar')}</span>
                        <span className="pv-father-name">{person.name}</span>
                        {sons.length > 0 && (
                          <span style={{ fontSize: '12px', color: '#8c6d3b', fontWeight: 600 }}>
                            (له أعقاب مسجلة)
                          </span>
                        )}
                      </div>

                      {/* Wives Row */}
                      {wives && wives.length > 0 && (
                        <div className="pv-wives-list">
                          <span style={{ fontWeight: 700 }}>الزوجات:</span>
                          {wives.map((w, idx) => (
                            <span key={idx} className="pv-wife-pill">
                              ⚭ {wifeShortLabel(w, root)}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Children List */}
                      {sons.length === 0 && daughters.length === 0 ? (
                        <p style={{ fontSize: '12px', color: '#8c7b64', margin: '4px 0' }}>
                          — لا عقب مسجّل في هذا الفرع
                        </p>
                      ) : (
                        <div className="pv-children-group">
                          {/* Sons */}
                          {sons.length > 0 && (
                            <div className="pv-sons-block">
                              <span className="pv-child-category-label">
                                الأبناء الذكور ({sons.length.toLocaleString('ar')}):
                              </span>
                              <div className="pv-child-items">
                                {sons.map((s, i) => (
                                  <span key={s.id} className="pv-child-item-chip male">
                                    <span>{(i + 1).toLocaleString('ar')}.</span>
                                    <strong>{s.name}</strong>
                                    {s.mother && (
                                      <span className="pv-mother-assign-tag">
                                        أم: {motherDisplayLabel(s, person, root)}
                                      </span>
                                    )}
                                    {(s.children.length > 0 || s.wives.length > 0) && (
                                      <span className="pv-has-sub-indicator" title="له ذرية مفصلة">
                                        ↓ له ذرية
                                      </span>
                                    )}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Daughters */}
                          {daughters.length > 0 && (
                            <div className="pv-daughters-block">
                              <span className="pv-child-category-label">
                                البنات ({daughters.length.toLocaleString('ar')}):
                              </span>
                              <div className="pv-child-items">
                                {daughters.map((d, i) => {
                                  const maternal = mothersMap.get(d.id)
                                  return (
                                    <span key={d.id} className="pv-child-item-chip female">
                                      <span>{(i + 1).toLocaleString('ar')}.</span>
                                      <strong>{d.name}</strong>
                                      {d.mother && (
                                        <span className="pv-mother-assign-tag">
                                          أم: {motherDisplayLabel(d, person, root)}
                                        </span>
                                      )}

                                      {/* Maternal Highlight if Daughter is Mother in Tree */}
                                      {maternal && maternal.length > 0 && (
                                        <span className="pv-mother-callout" title="أم لأفراد في هذا المشجر">
                                          🌸 أم لـ:{' '}
                                          {maternal
                                            .map(
                                              (m) =>
                                                `${m.childrenNames.join('، ')} (زوجة ${
                                                  m.husbandName
                                                })`
                                            )
                                            .join(' · ')}
                                        </span>
                                      )}
                                    </span>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </section>

              {/* Document Footer & Certification */}
              <footer className="pv-doc-footer">
                <div className="pv-cert-grid">
                  <div className="pv-cert-box">
                    <div className="pv-cert-box-title">✍️ إقرار وتوثيق النسب</div>
                    <div className="pv-cert-line">المحرر: .......................................</div>
                    <div className="pv-cert-line">التاريخ: {currentDate}</div>
                    <div className="pv-cert-sig-line"></div>
                    <div style={{ fontSize: '10px', color: '#8c7b64', marginTop: '4px' }}>
                      التوقيع والختم
                    </div>
                  </div>

                  <div className="pv-cert-box">
                    <div className="pv-cert-box-title">📜 مصادقة عميد الأسرة</div>
                    <div className="pv-cert-line">الاسم: .......................................</div>
                    <div className="pv-cert-line">الصفة: عميد الأسرة / ممثل الفخذ</div>
                    <div className="pv-cert-sig-line"></div>
                    <div style={{ fontSize: '10px', color: '#8c7b64', marginTop: '4px' }}>
                      المصادقة والاعتماد
                    </div>
                  </div>
                </div>

                <p className="pv-doc-closing">
                  طُبع هذا السجل آلياً عبر نظام «نَسَب» لحفظ وتوثيق الأنساب العائلية
                </p>
              </footer>
            </div>
          </div>
        </article>
      )}
    </div>
  )
}

// =============================================================================
// Interactive Canvas Component (Zoom, Pan, Expand, Collapse)
// =============================================================================

function InteractiveTreeCanvas({
  root,
  selectedPerson,
  onSelectPerson,
}: {
  root: Person
  selectedPerson: Person | null
  onSelectPerson: (p: Person) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(0.85)
  const [pan, setPan] = useState({ x: 0, y: 50 })
  const [isDragging, setIsDragging] = useState(false)

  const dragStartRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0 })
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const initialPinchDistRef = useRef<number | null>(null)
  const initialZoomRef = useRef<number>(1)

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const s = new Set<string>([root.id])
    root.children.forEach((c) => {
      if (c.children.length > 0) s.add(c.id)
    })
    return s
  })

  // Auto expand selected person path
  useEffect(() => {
    if (selectedPerson) {
      const path = findPath(root, selectedPerson.id)
      if (path.length > 0) {
        setExpandedIds((prev) => {
          const next = new Set(prev)
          path.forEach((p) => next.add(p.id))
          return next
        })
      }
    }
  }, [selectedPerson, root])

  const layout = useMemo(
    () => computeTreeLayout(root, expandedIds),
    [root, expandedIds]
  )

  useEffect(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const fitZoom = Math.min(1, Math.max(0.4, (rect.width - 40) / layout.bounds.width))
    const centerX = (rect.width - layout.bounds.width * fitZoom) / 2 - layout.bounds.minX * fitZoom
    setPan({ x: isNaN(centerX) ? 20 : centerX, y: 60 })
    setZoom(fitZoom)
  }, [root])

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.08 : 0.08
    setZoom((z) => Math.max(0.15, Math.min(2.2, z + delta)))
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)

    if (activePointersRef.current.size === 1) {
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      panStartRef.current = { ...pan }
    } else if (activePointersRef.current.size === 2) {
      setIsDragging(false)
      const pts = Array.from(activePointersRef.current.values())
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      initialPinchDistRef.current = dist
      initialZoomRef.current = zoom
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!activePointersRef.current.has(e.pointerId)) return
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (activePointersRef.current.size === 1 && isDragging) {
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      setPan({
        x: panStartRef.current.x + dx,
        y: panStartRef.current.y + dy,
      })
    } else if (activePointersRef.current.size === 2 && initialPinchDistRef.current) {
      const pts = Array.from(activePointersRef.current.values())
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (dist > 0 && initialPinchDistRef.current > 0) {
        const scale = dist / initialPinchDistRef.current
        setZoom(Math.max(0.15, Math.min(2.2, initialZoomRef.current * scale)))
      }
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    activePointersRef.current.delete(e.pointerId)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }
    if (activePointersRef.current.size < 2) initialPinchDistRef.current = null
    if (activePointersRef.current.size === 0) setIsDragging(false)
  }

  function toggleExpand(personId: string, e: React.MouseEvent) {
    e.stopPropagation()
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(personId)) next.delete(personId)
      else next.add(personId)
      return next
    })
  }

  function resetCenter() {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const fitZoom = Math.min(1, Math.max(0.4, (rect.width - 40) / layout.bounds.width))
    const centerX = (rect.width - layout.bounds.width * fitZoom) / 2 - layout.bounds.minX * fitZoom
    setPan({ x: isNaN(centerX) ? 20 : centerX, y: 60 })
    setZoom(fitZoom)
  }

  function expandAll() {
    const all = new Set<string>()
    function collect(p: Person) {
      if (p.children.length > 0) all.add(p.id)
      p.children.forEach(collect)
    }
    collect(root)
    setExpandedIds(all)
  }

  function collapseAll() {
    setExpandedIds(new Set([root.id]))
  }

  return (
    <div
      className={`v-canvas-viewport ${isDragging ? 'is-dragging' : ''}`}
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{ touchAction: 'none' }}
    >
      <div className="v-floating-controls">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(2.2, z + 0.15))}
          title="تكبير"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.15, z - 0.15))}
          title="تصغير"
        >
          −
        </button>
        <button type="button" onClick={resetCenter} title="إعادة توسيط">
          ⌖
        </button>
        <button
          type="button"
          onClick={expandedIds.size > 2 ? collapseAll : expandAll}
          title="طي / توسيع الكل"
        >
          {expandedIds.size > 2 ? 'طي' : 'فرد'}
        </button>
      </div>

      <div
        className="v-canvas-content"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        <svg className="v-tree-svg" style={{ overflow: 'visible' }}>
          {layout.links.map((link) => {
            const midY = (link.y1 + link.y2) / 2
            const d = `M ${link.x1} ${link.y1} C ${link.x1} ${midY}, ${link.x2} ${midY}, ${link.x2} ${link.y2}`
            return (
              <path
                key={link.id}
                d={d}
                fill="none"
                stroke="var(--border-focus, #c9b897)"
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            )
          })}
        </svg>

        {layout.nodes.map((node) => {
          const isSelected = selectedPerson?.id === node.person.id
          const isMale = node.person.gender === 'M'

          return (
            <div
              key={node.person.id}
              className={`v-tree-card ${isMale ? 'card-m' : 'card-f'} ${
                isSelected ? 'is-selected' : ''
              }`}
              style={{
                position: 'absolute',
                left: `${node.x - CARD_WIDTH / 2}px`,
                top: `${node.y}px`,
                width: `${CARD_WIDTH}px`,
                minHeight: `${CARD_HEIGHT}px`,
              }}
              onClick={() => onSelectPerson(node.person)}
            >
              <div className="v-card-header">
                <span className={`v-dot ${isMale ? 'dot-m' : 'dot-f'}`} />
                {node.hasChildren && (
                  <button
                    type="button"
                    className="v-expand-pill"
                    onClick={(e) => toggleExpand(node.person.id, e)}
                    title={node.isExpanded ? 'طي الفروع' : 'فتح الفروع'}
                  >
                    {node.isExpanded ? '−' : `+${node.person.children.length}`}
                  </button>
                )}
              </div>

              <div className="v-card-name" dir="auto">
                {node.person.name}
              </div>

              {node.person.wives && node.person.wives.length > 0 && (
                <div className="v-card-wives-count">
                  ⚭ {node.person.wives.length}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// Slide-up Person Profile Sheet
// =============================================================================

function PersonBottomSheet({
  person,
  root,
  mothersMap,
  onClose,
  onSelectPerson,
  onShare,
}: {
  person: Person
  root: Person
  mothersMap: Map<string, MaternalInfo[]>
  onClose: () => void
  onSelectPerson: (p: Person) => void
  onShare: () => void
}) {
  const lineage = getLineageChain(root, person.id)
  const isMale = person.gender === 'M'
  const maternal = mothersMap.get(person.id)

  return (
    <div className="v-sheet-backdrop" onClick={onClose} dir="rtl">
      <div className="v-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="v-sheet-handle" />

        <div className="v-sheet-header">
          <div className="v-sheet-title-group">
            <span className={`v-gender-tag ${isMale ? 'tag-m' : 'tag-f'}`}>
              {isMale ? 'ذكر' : 'أنثى'}
            </span>
            <h2 className="v-sheet-name">{person.name}</h2>
          </div>
          <button type="button" className="v-sheet-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Full Ancestry Lineage */}
        {lineage && (
          <div className="v-sheet-lineage">
            <span className="v-lineage-label">سلسلة النسب:</span>
            <p className="v-sheet-lineage-text">{lineage}</p>
          </div>
        )}

        {/* Maternal Highlight for Females */}
        {!isMale && maternal && maternal.length > 0 && (
          <div className="v-sheet-section" style={{ background: 'var(--accent-soft)', padding: '10px 14px', borderRadius: '8px' }}>
            <h3 className="v-sheet-label" style={{ color: 'var(--accent)', marginBottom: '4px' }}>
              🌸 ذرية الأم في المشجر:
            </h3>
            {maternal.map((m, i) => (
              <p key={i} style={{ margin: '3px 0', fontSize: '13px' }}>
                أم لـ: <strong>{m.childrenNames.join('، ')}</strong> (مع زوجها {m.husbandName})
              </p>
            ))}
          </div>
        )}

        {/* Wives */}
        {person.wives && person.wives.length > 0 && (
          <div className="v-sheet-section">
            <h3 className="v-sheet-label">الزوجات ({person.wives.length}):</h3>
            <div className="v-sheet-chips">
              {person.wives.map((wife, i) => {
                const linkedFemale = resolveWife(wife, root)
                if (linkedFemale) {
                  return (
                    <button
                      key={i}
                      type="button"
                      className="v-chip v-chip-link"
                      onClick={() => onSelectPerson(linkedFemale)}
                    >
                      🔗 {linkedFemale.name} (من المشجر)
                    </button>
                  )
                }
                return (
                  <span key={i} className="v-chip">
                    {wifeShortLabel(wife, root)}
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {/* Children */}
        <div className="v-sheet-section">
          <h3 className="v-sheet-label">
            الأبناء والبنات ({person.children.length}):
          </h3>
          {person.children.length === 0 ? (
            <p className="v-empty-sub">لا توجد ذرية مسجلة</p>
          ) : (
            <div className="v-sheet-children">
              {person.children.map((child) => {
                const childIsMale = child.gender === 'M'
                return (
                  <button
                    key={child.id}
                    type="button"
                    className={`v-child-btn ${childIsMale ? 'male' : 'female'}`}
                    onClick={() => onSelectPerson(child)}
                  >
                    <span className={`v-dot ${childIsMale ? 'dot-m' : 'dot-f'}`} />
                    <span>{child.name}</span>
                    {child.children.length > 0 && (
                      <span className="v-child-sub-count">
                        ({child.children.length})
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Share Button */}
        <button type="button" className="v-share-btn" onClick={onShare}>
          📋 مشاركة رابط مباشر لهذا الشخص
        </button>
      </div>
    </div>
  )
}
