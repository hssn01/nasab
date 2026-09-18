import React, { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Person, TreeState } from '../types'
import { resolveWife, wifeShortLabel, findPath } from '../treeUtils'
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

function getLineageChain(root: Person, targetId: string): string {
  const path = findPath(root, targetId)
  if (path.length === 0) return ''
  return [...path]
    .reverse()
    .map((p) => p.name)
    .join(' بن ')
}

function flattenTree(root: Person): PersonWithContext[] {
  const list: PersonWithContext[] = []

  function traverse(
    node: Person,
    parent: Person | null,
    ancestors: Person[],
    generation: number
  ) {
    const lineage = [...ancestors, node].reverse().map((p) => p.name).join(' بن ')
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

// ── Main Mobile App Component ───────────────────────────────────────────────

export function ViewerMobileApp() {
  const [treeState, setTreeState] = useState<TreeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'tree' | 'search'>('tree')
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  // Load Tree Data
  useEffect(() => {
    async function load() {
      setLoading(true)
      const params = new URLSearchParams(window.location.search)
      const treeId = params.get('t') || params.get('tree')
      const personId = params.get('person')

      try {
        let query = supabase.from('trees').select('id, name, state')
        if (treeId) {
          query = query.eq('id', treeId)
        } else {
          query = query.order('updated_at', { ascending: false }).limit(1)
        }

        const { data, error } = await query
        if (error) throw error

        if (data && data.length > 0) {
          const raw = data[0].state
          const state: TreeState = typeof raw === 'string' ? JSON.parse(raw) : raw
          setTreeState(state)

          if (personId && state?.root) {
            const found = flattenTree(state.root).find((p) => p.person.id === personId)
            if (found) {
              setSelectedPerson(found.person)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load tree data:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // All People Flat List
  const allPeople = useMemo(() => {
    if (!treeState?.root) return []
    return flattenTree(treeState.root)
  }, [treeState])

  // Filtered List
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return allPeople
    const q = searchable(searchQuery)
    return allPeople.filter(
      (item) =>
        searchable(item.person.name).includes(q) ||
        searchable(item.lineage).includes(q)
    )
  }, [allPeople, searchQuery])

  function showToast(msg: string) {
    setToastMsg(msg)
    setTimeout(() => setToastMsg(null), 2500)
  }

  function handleShare(personId?: string) {
    const url = new URL(window.location.href)
    url.searchParams.set('view', 'viewer')
    if (personId) url.searchParams.set('person', personId)
    navigator.clipboard.writeText(url.toString())
    showToast('تم نسخ الرابط إلى الحافظة بنجاح!')
  }

  if (loading) {
    return (
      <div className="v-loading" dir="rtl">
        <div className="v-spinner" />
        <p>جارٍ تحميل شجرة النسب…</p>
      </div>
    )
  }

  if (!treeState?.root) {
    return (
      <div className="v-loading" dir="rtl">
        <p>لم يتم العثور على بيانات الشجرة</p>
        <a href="/" className="v-back-link">العودة للصفحة الرئيسية</a>
      </div>
    )
  }

  const rootName = treeState.root.name

  return (
    <div className="v-root" dir="rtl">
      {/* ── Top App Bar ── */}
      <header className="v-header">
        <div className="v-header-title-box">
          <h1 className="v-title">شجرة {rootName}</h1>
          <span className="v-counter-pill">{allPeople.length} فرد</span>
        </div>

        {/* View Switcher Tabs */}
        <nav className="v-nav">
          <button
            type="button"
            className={`v-nav-btn ${view === 'tree' ? 'active' : ''}`}
            onClick={() => setView('tree')}
          >
            🌳 المشجّر
          </button>
          <button
            type="button"
            className={`v-nav-btn ${view === 'search' ? 'active' : ''}`}
            onClick={() => setView('search')}
          >
            🔍 البحث ({allPeople.length})
          </button>
        </nav>

        <a href="/" className="v-home-btn" title="العودة للرئيسية">
          الرئيسية 🏠
        </a>
      </header>

      {/* ── Visual Tree Canvas View ── */}
      {view === 'tree' && (
        <InteractiveTreeCanvas
          root={treeState.root}
          selectedPerson={selectedPerson}
          onSelectPerson={(p) => setSelectedPerson(p)}
        />
      )}

      {/* ── Search & Directory View ── */}
      {view === 'search' && (
        <div className="v-search-container">
          <div className="v-search-bar">
            <input
              type="search"
              dir="rtl"
              placeholder="ابحث باسم الشخص أو النسب…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
            {searchQuery && (
              <button
                type="button"
                className="v-search-clear"
                onClick={() => setSearchQuery('')}
              >
                ✕
              </button>
            )}
          </div>

          <p className="v-result-count">
            {searchQuery
              ? `تم العثور على ${filtered.length} شخص`
              : `إجمالي المسجلين: ${allPeople.length} فرد`}
          </p>

          <div className="v-people-list">
            {filtered.length === 0 ? (
              <div className="v-empty">لا توجد نتائج مطابقة لبحثك</div>
            ) : (
              filtered.map(({ person, lineage }) => {
                const isMale = person.gender === 'M'
                return (
                  <div
                    key={person.id}
                    className={`v-person-card ${isMale ? 'male-card' : 'female-card'}`}
                    onClick={() => {
                      setSelectedPerson(person)
                      setView('tree')
                    }}
                  >
                    <div className="v-card-main">
                      <div className="v-card-name-row">
                        <span className={`v-dot ${isMale ? 'dot-m' : 'dot-f'}`} />
                        <span className="v-card-name">{person.name}</span>
                        {person.children.length > 0 && (
                          <span className="v-children-count">
                            {person.children.length} من الذرية
                          </span>
                        )}
                      </div>
                      <p className="v-card-lineage">{lineage}</p>
                    </div>
                    <button
                      type="button"
                      className="v-card-action"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedPerson(person)
                      }}
                    >
                      بطاقة الفرد ‹
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* ── Slide-up Person Profile Sheet ── */}
      {selectedPerson && treeState.root && (
        <PersonBottomSheet
          person={selectedPerson}
          root={treeState.root}
          onClose={() => setSelectedPerson(null)}
          onSelectPerson={(p) => setSelectedPerson(p)}
          onShare={() => handleShare(selectedPerson.id)}
        />
      )}

      {/* ── Toast Notification ── */}
      {toastMsg && <div className="v-toast">{toastMsg}</div>}
    </div>
  )
}

// ── Interactive SVG Tree Canvas Component ───────────────────────────────────

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

  // Collapsible nodes state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const s = new Set<string>([root.id])
    // Expand root's children by default so the tree is immediately visible and impressive
    root.children.forEach((c) => {
      if (c.children.length > 0) s.add(c.id)
    })
    return s
  })

  // Auto-expand path to selected person
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

  // Auto-fit on initial render
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
    if (activePointersRef.current.size < 2) {
      initialPinchDistRef.current = null
    }
    if (activePointersRef.current.size === 0) {
      setIsDragging(false)
    }
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
      {/* Floating Canvas Controls */}
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

      {/* Main Transform Container */}
      <div
        className="v-canvas-content"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {/* SVG Tree Connection Links */}
        <svg className="v-tree-svg" style={{ overflow: 'visible' }}>
          {layout.links.map((link) => {
            const midY = (link.y1 + link.y2) / 2
            const d = `M ${link.x1} ${link.y1} C ${link.x1} ${midY}, ${link.x2} ${midY}, ${link.x2} ${link.y2}`
            return (
              <path
                key={link.id}
                d={d}
                fill="none"
                stroke="#c9b897"
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            )
          })}
        </svg>

        {/* Tree Node Cards */}
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

// ── Slide-up Person Profile Sheet ───────────────────────────────────────────

function PersonBottomSheet({
  person,
  root,
  onClose,
  onSelectPerson,
  onShare,
}: {
  person: Person
  root: Person
  onClose: () => void
  onSelectPerson: (p: Person) => void
  onShare: () => void
}) {
  const lineage = getLineageChain(root, person.id)
  const isMale = person.gender === 'M'

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
                      🔗 {linkedFemale.name} (من القبيلة)
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
