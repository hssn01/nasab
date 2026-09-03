import { useMemo, useState, useRef, useEffect } from 'react'
import type { Person } from '../types'
import { collectFemales, getLineageText, resolveWife } from '../treeUtils'



interface VisualTreeChartProps {
  root: Person
  selectedId: string | null
  currentId: string | null
  onSelectPerson: (person: Person) => void
  onGoToEditorForPerson?: (person: Person) => void
  onRenamePerson?: (personId: string, name: string) => void
  onAddChildrenBatch?: (personId: string, sons: string[], daughters: string[]) => void
  onDeletePerson?: (personId: string) => void
  onAddWife?: (personId: string, wifeNameOrId: string) => void
  onRemoveWife?: (personId: string, index: number) => void
}

interface TreePosNode {
  person: Person
  x: number
  y: number
  width: number
  children: TreePosNode[]
  parentId?: string
  hasChildren: boolean
  isExpanded: boolean
}

const CARD_WIDTH = 155
const CARD_HEIGHT = 76
const NODE_GAP = 24
const LEVEL_HEIGHT = 120

function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .toLocaleLowerCase('ar')
    .trim()
}

function findPathToNode(root: Person, targetId: string): string[] {
  function dfs(node: Person, path: string[]): string[] | null {
    const currentPath = [...path, node.id]
    if (node.id === targetId) return currentPath
    for (const child of node.children) {
      const res = dfs(child, currentPath)
      if (res) return res
    }
    return null
  }
  return dfs(root, []) ?? []
}

function collectAllNodeIds(node: Person, set = new Set<string>()): Set<string> {
  if (node.children.length > 0) set.add(node.id)
  node.children.forEach((c) => collectAllNodeIds(c, set))
  return set
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

  function assignCoords(node: TreePosNode, left: number, depth: number, parentId?: string) {
    node.y = depth * LEVEL_HEIGHT
    node.parentId = parentId

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
        assignCoords(child, currentLeft, depth + 1, node.person.id)
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

  return { layoutRoot, nodes, links, bounds }
}

export function VisualTreeChart({
  root,
  selectedId,
  currentId,
  onSelectPerson,
  onGoToEditorForPerson,
  onRenamePerson,
  onAddChildrenBatch,
  onDeletePerson,
  onAddWife,
  onRemoveWife,
}: VisualTreeChartProps) {

  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0 })

  // Collapsible nodes state: by default only root is expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set([root.id]))

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)

  // Node action modal state
  const [actionPerson, setActionPerson] = useState<Person | null>(null)
  const [modalTab, setModalTab] = useState<'options' | 'rename' | 'children' | 'wives'>('options')
  const [editName, setEditName] = useState('')
  const [sonsText, setSonsText] = useState('')
  const [daughtersText, setDaughtersText] = useState('')
  const [newWifeInput, setNewWifeInput] = useState('')
  const [selectedTribeFemaleId, setSelectedTribeFemaleId] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)


  const layout = useMemo(
    () => computeTreeLayout(root, expandedIds),
    [root, expandedIds],
  )

  // Find search matches across the whole tree
  const matches = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchable(searchQuery)
    const result: Person[] = []

    function search(person: Person) {
      const text = searchable(`${person.name} ${person.id}`)
      if (text.includes(q)) result.push(person)
      person.children.forEach(search)
    }

    search(root)
    return result
  }, [root, searchQuery])

  // Pointer & Touch event handling for mobile dragging and pinch-zoom
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const initialPinchDistRef = useRef<number | null>(null)
  const initialZoomRef = useRef<number>(1)

  // Auto-fit zoom on mount for mobile screens
  useEffect(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const isMobile = rect.width <= 600
    const initialZoom = isMobile ? Math.min(0.85, rect.width / (layout.bounds.width + 40)) : 1
    const safeZoom = Math.max(0.35, Math.min(1, initialZoom))
    const centerX = (rect.width - layout.bounds.width * safeZoom) / 2 - layout.bounds.minX * safeZoom
    setPan({ x: isNaN(centerX) ? 20 : centerX, y: isMobile ? 80 : 50 })
    setZoom(safeZoom)
  }, [root])

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.08 : 0.08
    setZoom((z) => Math.max(0.1, Math.min(2.5, z + delta)))
  }

  function handlePointerDown(e: React.PointerEvent) {
    // Only capture primary touch or left mouse button
    if (e.pointerType === 'mouse' && e.button !== 0) return
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)

    if (activePointersRef.current.size === 1) {
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      panStartRef.current = { ...pan }
    } else if (activePointersRef.current.size === 2) {
      setIsDragging(false)
      const pointers = Array.from(activePointersRef.current.values())
      const dist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y)
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
      const pointers = Array.from(activePointersRef.current.values())
      const dist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y)
      if (dist > 0 && initialPinchDistRef.current > 0) {
        const scale = dist / initialPinchDistRef.current
        setZoom(Math.max(0.1, Math.min(2.5, initialZoomRef.current * scale)))
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


  function toggleExpand(personId: string, event?: React.MouseEvent) {
    if (event) event.stopPropagation()
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(personId)) next.delete(personId)
      else next.add(personId)
      return next
    })
  }

  function expandAll() {
    setExpandedIds(collectAllNodeIds(root))
  }

  function collapseAll() {
    setExpandedIds(new Set([root.id]))
  }

  function openActionModal(person: Person) {
    setActionPerson(person)
    setModalTab('options')
    setEditName(person.name)
    const sons = person.children.filter((c) => c.gender === 'M').map((c) => c.name)
    const daughters = person.children.filter((c) => c.gender === 'F').map((c) => c.name)
    setSonsText(sons.join('\n'))
    setDaughtersText(daughters.join('\n'))
    setDeleteConfirm(false)
  }

  function closeActionModal() {
    setActionPerson(null)
    setDeleteConfirm(false)
  }

  const activeMatch = matches[matchIndex % matches.length]

  return (
    <div className="visual-tree-container" ref={containerRef}>
      {/* Top Toolbar */}
      <div className="visual-tree-toolbar">
        <div className="visual-search-box">
          <input
            type="search"
            dir="rtl"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setMatchIndex(0)
            }}
            placeholder="ابحث باسم الشخص أو المعرف…"
            aria-label="البحث في المخطط المرئي"
          />
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => {
                setSearchQuery('')
                setMatchIndex(0)
              }}
            >
              ×
            </button>
          )}
          {matches.length > 0 && (
            <div className="search-match-count">
              <span>
                {matchIndex + 1} / {matches.length}
              </span>
              <button
                type="button"
                className="match-nav-btn"
                onClick={() =>
                  setMatchIndex((i) => (i - 1 + matches.length) % matches.length)
                }
                title="السابق"
              >
                ‹
              </button>
              <button
                type="button"
                className="match-nav-btn"
                onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
                title="التالي"
              >
                ›
              </button>
            </div>
          )}
        </div>

        <div className="visual-tree-controls">
          <button
            type="button"
            className="compact-button"
            onClick={expandAll}
            title="توسيع كل الفروع"
          >
            توسيع الكل
          </button>
          <button
            type="button"
            className="compact-button"
            onClick={collapseAll}
            title="طي كل الفروع"
          >
            طي الكل
          </button>

          <span className="control-sep">|</span>

          <button
            type="button"
            className="compact-button"
            onClick={() => setZoom((z) => Math.min(2.5, z + 0.15))}
            title="تكبير"
          >
            +
          </button>
          <button
            type="button"
            className="compact-button"
            onClick={() => setZoom((z) => Math.max(0.1, z - 0.15))}
            title="تصغير"
          >
            -
          </button>
          <button
            type="button"
            className="compact-button"
            onClick={() => {
              if (!containerRef.current) return
              const rect = containerRef.current.getBoundingClientRect()
              setPan({
                x: (rect.width - layout.bounds.width) / 2 - layout.bounds.minX,
                y: 50,
              })
              setZoom(1)
            }}
            title="توسيط الشجرة"
          >
            توسيط
          </button>
          <span className="zoom-level">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* Main Drag/Zoom Viewport */}
      <div
        className={`visual-tree-viewport${isDragging ? ' is-dragging' : ''}`}
        style={{ touchAction: 'none' }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >

        <div
          className="visual-tree-canvas"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {/* Connecting SVG Lines */}
          <svg
            className="visual-tree-svg"
            style={{
              width: `${Math.max(6000, layout.bounds.width + 2000)}px`,
              height: `${Math.max(4000, layout.bounds.height + 1500)}px`,
              position: 'absolute',
              top: 0,
              left: 0,
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            {layout.links.map((link) => {
              const midY = (link.y1 + link.y2) / 2
              const path = `M ${link.x1} ${link.y1} C ${link.x1} ${midY}, ${link.x2} ${midY}, ${link.x2} ${link.y2}`
              return (
                <path
                  key={link.id}
                  d={path}
                  fill="none"
                  stroke="var(--border-strong)"
                  strokeWidth={Math.max(1.5, 2 / zoom)}
                  className="tree-link-path"
                />
              )
            })}
          </svg>

          {/* Node Cards */}
          {layout.nodes.map((node) => {
            const isSelected = selectedId === node.person.id
            const isCurrent = currentId === node.person.id
            const isMatch = activeMatch && activeMatch.id === node.person.id
            const isMale = node.person.gender === 'M'

            return (
              <div
                key={node.person.id}
                className={`visual-node-card ${isMale ? 'card-m' : 'card-f'}${
                  isSelected ? ' is-selected' : ''
                }${isCurrent ? ' is-current' : ''}${isMatch ? ' is-match' : ''}${
                  zoom < 0.45 ? ' compact-mode' : ''
                }`}
                style={{
                  position: 'absolute',
                  left: `${node.x - CARD_WIDTH / 2}px`,
                  top: `${node.y}px`,
                  width: `${CARD_WIDTH}px`,
                  minHeight: `${CARD_HEIGHT}px`,
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectPerson(node.person)
                  openActionModal(node.person)
                }}
              >
                <div className="visual-card-header">
                  <span className={`badge badge-${node.person.gender.toLowerCase()}`}>
                    {node.person.id}
                  </span>
                  {node.hasChildren && (
                    <button
                      type="button"
                      className="visual-toggle-btn"
                      onClick={(e) => toggleExpand(node.person.id, e)}
                      title={node.isExpanded ? 'طي الفروع' : 'توسيع الفروع'}
                    >
                      {node.isExpanded ? '−' : `+ ${node.person.children.length}`}
                    </button>
                  )}
                </div>

                <div className="visual-card-name" dir="auto" title={node.person.name}>
                  {node.person.name}
                </div>

                {node.person.wives && node.person.wives.length > 0 && (
                  <div className="visual-card-wives">

                    {node.person.wives.map((wifeStr, idx) => {
                      const linkedFemale = resolveWife(wifeStr, root)
                      if (linkedFemale) {
                        return (
                          <span
                            key={idx}
                            className="wife-link-tag"
                            onClick={(e) => {
                              e.stopPropagation()
                              const path = findPathToNode(root, linkedFemale.id)
                              setExpandedIds((prev) => {
                                const next = new Set(prev)
                                path.forEach((id) => next.add(id))
                                return next
                              })
                              onSelectPerson(linkedFemale)
                            }}
                            title={`زوجة من نفس القبيلة: ${linkedFemale.name} (${linkedFemale.id}) - انقر للانتقال إليها`}
                          >
                            🔗 {linkedFemale.name} ({linkedFemale.id})
                          </span>
                        )
                      }
                      return <span key={idx}>⚭ {wifeStr}</span>
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Person Node Action Modal */}
      {actionPerson && (
        <div className="modal-backdrop" onClick={closeActionModal} dir="rtl">
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className={`badge badge-${actionPerson.gender.toLowerCase()}`}>
                  {actionPerson.id}
                </span>
                <h3 className="modal-title">{actionPerson.name}</h3>
                <p className="modal-lineage-text">
                  سلسلة الأجداد: {getLineageText(root, actionPerson.id)}
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={closeActionModal}
              >
                ×
              </button>
            </div>

            {modalTab === 'options' && (
              <div className="modal-options-list">
                <button
                  type="button"
                  className="modal-action-btn"
                  onClick={() => {
                    const path = findPathToNode(root, actionPerson.id)
                    setExpandedIds((prev) => {
                      const next = new Set(prev)
                      path.forEach((id) => next.add(id))
                      return next
                    })
                    closeActionModal()
                  }}
                >
                  🔍 إبراز سلسلة الأجداد في الشجرة
                </button>

                {actionPerson.gender === 'M' && (
                  <>
                    <button
                      type="button"
                      className="modal-action-btn primary-action"
                      onClick={() => setModalTab('children')}
                    >
                      ➕ إضافة أو تعديل الأبناء والبنات
                    </button>
                    <button
                      type="button"
                      className="modal-action-btn"
                      onClick={() => setModalTab('wives')}
                    >
                      💍 إضافة أو ربط زوجة (من القبيلة أو خارجية)
                    </button>
                  </>
                )}


                <button
                  type="button"
                  className="modal-action-btn"
                  onClick={() => setModalTab('rename')}
                >
                  ✏️ تعديل اسم الشخص
                </button>

                {onGoToEditorForPerson && (
                  <button
                    type="button"
                    className="modal-action-btn"
                    onClick={() => {
                      closeActionModal()
                      onGoToEditorForPerson(actionPerson)
                    }}
                  >
                    📝 فتح النموذج الكامل في الصفحة الأخرى
                  </button>
                )}

                {actionPerson.id !== root.id && onDeletePerson && (
                  <div className="modal-delete-section">
                    {deleteConfirm ? (
                      <div className="delete-confirm-row">
                        <span>هل أنت تأكد من الحذف؟</span>
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => {
                            onDeletePerson(actionPerson.id)
                            closeActionModal()
                          }}
                        >
                          تأكيد الحذف
                        </button>
                        <button
                          type="button"
                          className="compact-button"
                          onClick={() => setDeleteConfirm(false)}
                        >
                          إلغاء
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="modal-action-btn danger-action"
                        onClick={() => setDeleteConfirm(true)}
                      >
                        🗑️ حذف الشخص
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {modalTab === 'rename' && (
              <form
                className="modal-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (editName.trim() && onRenamePerson) {
                    onRenamePerson(actionPerson.id, editName.trim())
                    closeActionModal()
                  }
                }}
              >
                <label className="modal-label">
                  الاسم الجديد:
                  <input
                    type="text"
                    dir="rtl"
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>
                <div className="modal-form-actions">
                  <button type="submit" className="primary">
                    حفظ الاسم
                  </button>
                  <button
                    type="button"
                    className="compact-button"
                    onClick={() => setModalTab('options')}
                  >
                    رجوع
                  </button>
                </div>
              </form>
            )}

            {modalTab === 'children' && (
              <form
                className="modal-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (onAddChildrenBatch) {
                    const sons = sonsText
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean)
                    const daughters = daughtersText
                      .split('\n')
                      .map((d) => d.trim())
                      .filter(Boolean)
                    onAddChildrenBatch(actionPerson.id, sons, daughters)
                    // Automatically expand this node so new children appear!
                    setExpandedIds((prev) => new Set(prev).add(actionPerson.id))
                    closeActionModal()
                  }
                }}
              >
                <p className="hint">
                  أدخل كل اسم في سطر مستقل. أسرع طريقة لإضافة الذريّة:
                </p>
                <div className="modal-batch-fields">
                  <div className="modal-field">
                    <label>الأبناء (الأولاد):</label>
                    <textarea
                      dir="rtl"
                      rows={5}
                      value={sonsText}
                      onChange={(e) => setSonsText(e.target.value)}
                      placeholder="أدخل أسماء الأولاد هنا..."
                    />
                  </div>
                  <div className="modal-field">
                    <label>البنات:</label>
                    <textarea
                      dir="rtl"
                      rows={5}
                      value={daughtersText}
                      onChange={(e) => setDaughtersText(e.target.value)}
                      placeholder="أدخل أسماء البنات هنا..."
                    />
                  </div>
                </div>
                <div className="modal-form-actions">
                  <button type="submit" className="primary">
                    حفظ وإضافة الذرية
                  </button>
                  <button
                    type="button"
                    className="compact-button"
                    onClick={() => setModalTab('options')}
                  >
                    رجوع
                  </button>
                </div>
              </form>
            )}

            {modalTab === 'wives' && (
              <div className="modal-form">


                <h4 className="modal-section-subtitle">الزوجات الحاليّات:</h4>
                {actionPerson.wives && actionPerson.wives.length > 0 ? (
                  <ul className="wives-manage-list">
                    {actionPerson.wives.map((wifeStr, idx) => {
                      const linked = resolveWife(wifeStr, root)
                      return (
                        <li key={idx} className="wife-manage-item">
                          <span>
                            {linked ? (
                              <span className="wife-link-tag">
                                🔗 {linked.name} ({linked.id})
                              </span>
                            ) : (
                              `⚭ ${wifeStr}`
                            )}
                          </span>
                          {onRemoveWife && (
                            <button
                              type="button"
                              className="compact-button danger-text"
                              onClick={() => onRemoveWife(actionPerson.id, idx)}
                              title="حذف الزوجة"
                            >
                              حذف
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="hint">لم تُسجّل أي زوجة لهذا الشخص بعد.</p>
                )}

                <div className="modal-field" style={{ marginTop: '12px' }}>
                  <label>اختر زوجة من نساء القبيلة المسجلات:</label>
                  <div className="input-row">
                    <select
                      dir="rtl"
                      className="tribe-female-select"
                      value={selectedTribeFemaleId}
                      onChange={(e) => setSelectedTribeFemaleId(e.target.value)}
                    >
                      <option value="">-- اختر بنت من القبيلة --</option>
                      {collectFemales(root).map((female) => (
                        <option key={female.id} value={female.id}>
                          {female.name} ({female.id})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="primary"
                      disabled={!selectedTribeFemaleId}
                      onClick={() => {
                        const female = collectFemales(root).find(
                          (f) => f.id === selectedTribeFemaleId,
                        )
                        if (female && onAddWife) {
                          onAddWife(actionPerson.id, `${female.id} - ${female.name}`)
                          setSelectedTribeFemaleId('')
                        }
                      }}
                    >
                      ربط من القبيلة
                    </button>
                  </div>
                </div>

                <div className="modal-field" style={{ marginTop: '8px' }}>
                  <label>أو أدخل اسم زوجة من خارج القبيلة:</label>
                  <div className="input-row">
                    <input
                      type="text"
                      dir="rtl"
                      placeholder="اسم الزوجة..."
                      value={newWifeInput}
                      onChange={(e) => setNewWifeInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary"
                      disabled={!newWifeInput.trim()}
                      onClick={() => {
                        if (newWifeInput.trim() && onAddWife) {
                          onAddWife(actionPerson.id, newWifeInput.trim())
                          setNewWifeInput('')
                        }
                      }}
                    >
                      إضافة
                    </button>
                  </div>
                </div>

                <div className="modal-form-actions" style={{ marginTop: '14px' }}>
                  <button
                    type="button"
                    className="compact-button"
                    onClick={() => setModalTab('options')}
                  >
                    رجوع
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  )
}
