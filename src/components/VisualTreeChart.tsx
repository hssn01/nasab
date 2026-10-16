import { useMemo, useState, useRef, useEffect } from 'react'
import type { Person, TreeMeta, Wife, TreeWife } from '../types'
import {
  collectFemales,
  createExternalWife,
  createTreeWife,
  resolveWife,
  wifeShortLabel,
  wifeLineageFullLabel,
  motherDisplayLabel,
  findParent,
  getLineageText,
  getAllFemalesRelations,
} from '../treeUtils'
import { isEditorUnlocked } from './EditorCodeModal'
import { TreeWifePicker } from './TreeWifePicker'

interface VisualTreeChartProps {
  root: Person
  selectedId: string | null
  currentId: string | null
  isUnifiedView?: boolean
  isEditMode?: boolean
  currentTreeId?: string
  currentTreeName?: string
  availableTrees?: TreeMeta[]
  onSelectPerson: (person: Person) => void
  onGoToEditorForPerson?: (person: Person) => void
  onRenamePerson?: (personId: string, name: string) => void
  onAddChildrenBatch?: (personId: string, sons: string[], daughters: string[]) => void
  onDeletePerson?: (personId: string) => void
  onAddWife?: (personId: string, wife: Wife) => void
  onRemoveWife?: (personId: string, index: number) => void
  onLinkBranchForPerson?: (person: Person) => void
  onRequestEditUnlock?: () => void
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
  /** If this female has a linked spouse (husband), store his layout info */
  spouseNode?: { person: Person; x: number; y: number }
}

const CARD_WIDTH = 155
const CARD_HEIGHT = 76
const NODE_GAP = 24
const LEVEL_HEIGHT = 120
const SPOUSE_GAP = 12

function searchable(value: string): string {
  if (!value) return ''
  return value
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '') // remove tatweel and harakat
    .replace(/[أإآٱ]/g, 'ا')                  // normalize alefs
    .replace(/[ؤ]/g, 'و')                     // normalize waw with hamza
    .replace(/[ئ]/g, 'ي')                     // normalize yaa with hamza
    .replace(/ء/g, '')                         // remove standalone hamza
    .replace(/[ة]/g, 'ه')                      // normalize taa marbuta
    .replace(/[ى]/g, 'ي')                      // normalize alif maqsura
    .toLocaleLowerCase('ar')
    .trim()
}

function findPathToNode(root: Person, targetId: string): string[] {
  function dfs(node: Person, path: string[]): string[] | null {
    const currentPath = [...path, node.id]
    if (node.id === targetId) return currentPath
    if (node.linkedSpouse && node.linkedSpouse.id === targetId) {
      return [...currentPath, node.linkedSpouse.id]
    }
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
    const hasSpouse = !!person.linkedSpouse
    // Width of this node's own card row (wife + husband side by side if spouse exists)
    const ownRowWidth = hasSpouse ? CARD_WIDTH + SPOUSE_GAP + CARD_WIDTH : CARD_WIDTH

    if (!hasChildren || !isExpanded) {
      const pos: TreePosNode = {
        person,
        x: 0,
        y: 0,
        width: ownRowWidth,
        children: [],
        hasChildren,
        isExpanded,
      }
      return { pos, totalWidth: ownRowWidth }
    }

    const childResults = person.children.map(getSubtreeWidth)
    const childrenTotalWidth =
      childResults.reduce((acc, c) => acc + c.totalWidth, 0) +
      (person.children.length - 1) * NODE_GAP
    const totalWidth = Math.max(ownRowWidth, childrenTotalWidth)

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

    // Position linked spouse next to this node (wife on right, husband on left in RTL)
    if (node.person.linkedSpouse) {
      node.spouseNode = {
        person: node.person.linkedSpouse,
        x: node.x - CARD_WIDTH - SPOUSE_GAP,
        y: node.y,
      }
      // Shift the wife card to the right to make room
      // Center the pair: wife is at x, husband at x - CARD_WIDTH - SPOUSE_GAP
      // Adjust so the midpoint of the couple is at the original x
      const coupleShift = (CARD_WIDTH + SPOUSE_GAP) / 2
      node.x += coupleShift
      node.spouseNode.x = node.x - CARD_WIDTH - SPOUSE_GAP
    }
  }

  const { pos: layoutRoot } = getSubtreeWidth(root)
  assignCoords(layoutRoot, 0, 0)

  const nodes: TreePosNode[] = []
  const links: { id: string; x1: number; y1: number; x2: number; y2: number }[] = []

  function flatten(node: TreePosNode) {
    nodes.push(node)

    if (node.spouseNode) {
      // For spouse pairs, the connecting line goes from the midpoint between them down to children
      const midX = (node.x + node.spouseNode.x) / 2
      node.children.forEach((child) => {
        links.push({
          id: `${node.person.id}->${child.person.id}`,
          x1: midX,
          y1: node.y + CARD_HEIGHT,
          x2: child.x,
          y2: child.y,
        })
        flatten(child)
      })
    } else {
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
  }

  flatten(layoutRoot)

  let minX = Infinity
  let maxX = -Infinity
  let maxY = 0

  nodes.forEach((n) => {
    minX = Math.min(minX, n.x - CARD_WIDTH / 2)
    maxX = Math.max(maxX, n.x + CARD_WIDTH / 2)
    maxY = Math.max(maxY, n.y + CARD_HEIGHT)
    // Account for spouse cards
    if (n.spouseNode) {
      minX = Math.min(minX, n.spouseNode.x - CARD_WIDTH / 2)
      maxX = Math.max(maxX, n.spouseNode.x + CARD_WIDTH / 2)
    }
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
  isUnifiedView = false,
  isEditMode,
  currentTreeId,
  currentTreeName,
  availableTrees,
  onSelectPerson,
  onGoToEditorForPerson,
  onRenamePerson,
  onAddChildrenBatch,
  onDeletePerson,
  onAddWife,
  onRemoveWife,
  onLinkBranchForPerson,
  onRequestEditUnlock,
}: VisualTreeChartProps) {
  const effectiveEditMode = isEditMode ?? isEditorUnlocked()

  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0 })

  // Helper to collect all node IDs leading to connected branches
  const branchPathIds = useMemo(() => {
    const set = new Set<string>()
    function scan(node: Person, path: string[]) {
      const currentPath = [...path, node.id]
      if (node.branchMeta && node.branchMeta.type !== 'main') {
        currentPath.forEach((id) => set.add(id))
      }
      for (const child of node.children) {
        scan(child, currentPath)
      }
    }
    scan(root, [])
    return set
  }, [root])

  // Collapsible nodes state: by default only root is expanded, plus any branch paths if unified
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const set = new Set([root.id])
    if (isUnifiedView) {
      branchPathIds.forEach((id) => set.add(id))
    }
    return set
  })

  // Auto-expand branch paths whenever unified view is active or tree updates
  useEffect(() => {
    if (isUnifiedView && branchPathIds.size > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev)
        next.add(root.id)
        branchPathIds.forEach((id) => next.add(id))
        return next
      })
    }
  }, [isUnifiedView, branchPathIds, root.id])

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)

  // Node action modal state
  const [actionPerson, setActionPerson] = useState<Person | null>(null)
  const [modalTab, setModalTab] = useState<'info' | 'options' | 'rename' | 'children' | 'wives'>('options')
  const [editName, setEditName] = useState('')
  const [sonsText, setSonsText] = useState('')
  const [daughtersText, setDaughtersText] = useState('')
  const [newWifeName, setNewWifeName] = useState('')
  const [newWifeFamily, setNewWifeFamily] = useState('')
  const [newWifeTribute, setNewWifeTribute] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [tribeSearchQuery, setTribeSearchQuery] = useState('')
  const [showTreeWifePicker, setShowTreeWifePicker] = useState(false)

  // Precomputed map of all females' husbands and children
  const femalesRelationsMap = useMemo(() => {
    return getAllFemalesRelations(root)
  }, [root])

  // Computed info for actionPerson
  const femaleRelations = useMemo(() => {
    if (!actionPerson || actionPerson.gender !== 'F') return null
    return femalesRelationsMap.get(actionPerson.id) || null
  }, [actionPerson, femalesRelationsMap])

  const parent = useMemo(() => {
    if (!actionPerson) return null
    return findParent(root, actionPerson.id)
  }, [root, actionPerson])

  const motherName = useMemo(() => {
    if (!actionPerson || !parent) return null
    return motherDisplayLabel(actionPerson, parent, root)
  }, [actionPerson, parent, root])

  const sons = useMemo(() => {
    if (!actionPerson) return []
    if (actionPerson.gender === 'F' && femaleRelations) {
      return femaleRelations.sons
    }
    return actionPerson.children.filter((c) => c.gender === 'M')
  }, [actionPerson, femaleRelations])

  const daughters = useMemo(() => {
    if (!actionPerson) return []
    if (actionPerson.gender === 'F' && femaleRelations) {
      return femaleRelations.daughters
    }
    return actionPerson.children.filter((c) => c.gender === 'F')
  }, [actionPerson, femaleRelations])

  const lineageChain = useMemo(() => {
    if (!actionPerson) return ''
    return getLineageText(root, actionPerson.id)
  }, [root, actionPerson])

  const wivesInfo = useMemo(() => {
    if (!actionPerson || !actionPerson.wives) return []
    return actionPerson.wives.map((w) => ({
      wife: w,
      shortLabel: wifeShortLabel(w, root),
      fullLabel: wifeLineageFullLabel(w, root, 4),
      resolved: resolveWife(w, root),
    }))
  }, [actionPerson, root])

  const linkedFemaleIds = useMemo(() => {
    if (!actionPerson?.wives) return new Set<string>()
    return new Set(
      actionPerson.wives
        .filter((w): w is TreeWife => w.type === 'tree' && Boolean(w.personId))
        .map((w) => w.personId)
    )
  }, [actionPerson?.wives])

  const searchableTreeFemales = useMemo(() => {
    const list = collectFemales(root)
    return list.map((female) => {
      const lineage = getLineageText(root, female.id)
      return {
        female,
        lineage,
        isLinked: linkedFemaleIds.has(female.id),
      }
    })
  }, [root, linkedFemaleIds])

  const filteredTreeFemales = useMemo(() => {
    const available = searchableTreeFemales.filter((f) => !f.isLinked)
    if (!tribeSearchQuery.trim()) {
      return available.slice(0, 10)
    }
    const q = searchable(tribeSearchQuery)
    return available
      .filter((item) => {
        const text = searchable(`${item.female.name} ${item.female.id} ${item.lineage}`)
        return text.includes(q)
      })
      .slice(0, 20)
  }, [searchableTreeFemales, tribeSearchQuery])


  const layout = useMemo(
    () => computeTreeLayout(root, expandedIds),
    [root, expandedIds],
  )

  // Find search matches across the whole tree
  const matches = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchable(searchQuery)
    if (!q) return []
    const searchTerms = q.split(/\s+/).filter(Boolean)
    const result: Person[] = []
    const seen = new Set<string>()

    function search(person: Person, ancestors: string[]) {
      if (seen.has(person.id)) return
      seen.add(person.id)

      const lineage = [person.name, ...ancestors].join(' ')
      const wivesText = (person.wives || [])
        .map((w) => (w.type === 'tree' ? (w.personName || '') : (w.name || '')))
        .join(' ')
      const metaText = person.branchMeta?.personName || person.branchMeta?.treeName || ''
      const rawText = `${person.name} ${person.id} ${person.branchMeta?.originalId || ''} ${metaText} ${lineage} ${wivesText}`
      const text = searchable(rawText)

      if (searchTerms.every((term) => text.includes(term))) {
        result.push(person)
      }

      // Also search linkedSpouse (husband attached to daughter branch)
      if (person.linkedSpouse && !seen.has(person.linkedSpouse.id)) {
        seen.add(person.linkedSpouse.id)
        const spouseWivesText = (person.linkedSpouse.wives || [])
          .map((w) => (w.type === 'tree' ? (w.personName || '') : (w.name || '')))
          .join(' ')
        const spouseRawText = `${person.linkedSpouse.name} ${person.linkedSpouse.id} ${person.linkedSpouse.branchMeta?.originalId || ''} ${person.linkedSpouse.branchMeta?.personName || ''} زوج ${person.name} ${spouseWivesText}`
        const spouseText = searchable(spouseRawText)
        if (searchTerms.every((term) => spouseText.includes(term))) {
          result.push(person.linkedSpouse)
        }
      }

      person.children.forEach((child) => search(child, [person.name, ...ancestors]))
    }

    search(root, [])
    return result
  }, [root, searchQuery])

  const activeMatch = matches.length > 0 ? matches[matchIndex % matches.length] : null
  const lastCenteredMatchRef = useRef<string | null>(null)

  // Auto-expand path to active search match
  useEffect(() => {
    if (!activeMatch) return
    const path = findPathToNode(root, activeMatch.id)
    if (path.length > 0) {
      setExpandedIds((prev) => {
        let changed = false
        const next = new Set(prev)
        path.forEach((id) => {
          if (!next.has(id)) {
            next.add(id)
            changed = true
          }
        })
        return changed ? next : prev
      })
    }
  }, [activeMatch, root])

  // Auto-center viewport on active search match
  useEffect(() => {
    if (!activeMatch || !containerRef.current) return
    const matchNode = layout.nodes.find(
      (n) => n.person.id === activeMatch.id || (n.spouseNode && n.spouseNode.person.id === activeMatch.id)
    )
    if (!matchNode) return

    const matchKey = `${activeMatch.id}_${matchIndex}`
    if (lastCenteredMatchRef.current === matchKey) return
    lastCenteredMatchRef.current = matchKey

    const targetX = matchNode.person.id === activeMatch.id ? matchNode.x : matchNode.spouseNode!.x
    const targetY = matchNode.y + CARD_HEIGHT / 2

    const rect = containerRef.current.getBoundingClientRect()
    const targetZoom = zoom < 0.6 ? 0.85 : zoom
    if (targetZoom !== zoom) {
      setZoom(targetZoom)
    }
    setPan({
      x: rect.width / 2 - targetX * targetZoom,
      y: rect.height / 2 - targetY * targetZoom,
    })
  }, [activeMatch, matchIndex, layout.nodes, zoom])

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

    // If pointer down is on interactive element (button, input, or card), do not capture viewport
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('input') || target.closest('.visual-node-card') || target.closest('.modal-card')) {
      return
    }

    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    panStartRef.current = { ...pan }

    if (activePointersRef.current.size === 1) {
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsDragging(true)
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
    if (event) {
      event.preventDefault()
      event.stopPropagation()
    }
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
    setModalTab(effectiveEditMode ? 'options' : 'info')
    setEditName(person.name)
    const sons = person.children.filter((c) => c.gender === 'M').map((c) => c.name)
    const daughters = person.children.filter((c) => c.gender === 'F').map((c) => c.name)
    setSonsText(sons.join('\n'))
    setDaughtersText(daughters.join('\n'))
    setNewWifeName('')
    setNewWifeFamily('')
    setNewWifeTribute('')
    setTribeSearchQuery('')
    setDeleteConfirm(false)
  }

  function closeActionModal() {
    setActionPerson(null)
    setDeleteConfirm(false)
  }

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
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (matches.length > 0) {
                  setMatchIndex((i) =>
                    e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length
                  )
                }
              }
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
          {searchQuery.trim() && matches.length === 0 && (
            <span style={{ fontSize: '0.8rem', opacity: 0.7, padding: '0 8px', whiteSpace: 'nowrap' }}>
              لا توجد نتائج
            </span>
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
                title="السابق (Shift+Enter)"
              >
                ‹
              </button>
              <button
                type="button"
                className="match-nav-btn"
                onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
                title="التالي (Enter)"
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
            {/* Spouse connector lines (horizontal between wife & husband) */}
            {layout.nodes.filter((n) => n.spouseNode).map((node) => {
              const sp = node.spouseNode!
              const wifeRight = node.x - CARD_WIDTH / 2
              const husbandLeft = sp.x + CARD_WIDTH / 2
              const lineY = node.y + CARD_HEIGHT / 2
              const midX = (node.x + sp.x) / 2
              return (
                <g key={`spouse-${node.person.id}`}>
                  {/* Horizontal line between the two cards */}
                  <line
                    x1={husbandLeft}
                    y1={lineY}
                    x2={wifeRight}
                    y2={lineY}
                    stroke="var(--female)"
                    strokeWidth={Math.max(2, 2.5 / zoom)}
                    strokeDasharray="6 3"
                    className="tree-spouse-line"
                  />
                  {/* Small heart/ring symbol at midpoint */}
                  <circle
                    cx={midX}
                    cy={lineY}
                    r={Math.max(4, 5 / zoom)}
                    fill="var(--female)"
                    opacity={0.7}
                  />
                  {/* Vertical drop line from midpoint down to CARD_HEIGHT */}
                  {node.children.length > 0 && node.isExpanded && (
                    <line
                      x1={midX}
                      y1={lineY}
                      x2={midX}
                      y2={node.y + CARD_HEIGHT}
                      stroke="var(--border-strong)"
                      strokeWidth={Math.max(1.5, 2 / zoom)}
                    />
                  )}
                </g>
              )
            })}
          </svg>

          {/* Node Cards */}
          {layout.nodes.map((node) => {
            const isSelected = selectedId === node.person.id
            const isCurrent = currentId === node.person.id
            const isMatch = activeMatch && activeMatch.id === node.person.id
            const isSearchResult = !isMatch && matches.some((m) => m.id === node.person.id)
            const isMale = node.person.gender === 'M'

            return (
              <div
                key={node.person.id}
                className={`visual-node-card ${isMale ? 'card-m' : 'card-f'}${
                  isSelected ? ' is-selected' : ''
                }${isCurrent ? ' is-current' : ''}${isMatch ? ' is-match' : isSearchResult ? ' is-search-result' : ''}${
                  zoom < 0.45 ? ' compact-mode' : ''
                }${node.person.branchMeta && node.person.branchMeta.type !== 'main' ? ' card-branch' : ''}${
                  node.person.branchMeta?.isVirtualContainer ? ' card-virtual-root' : ''
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
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  onSelectPerson(node.person)
                  openActionModal(node.person)
                }}
              >
                <div className="visual-card-header">
                  {!node.person.branchMeta?.isVirtualContainer && (
                    <span className={`badge badge-${node.person.gender.toLowerCase()}`}>
                      {node.person.branchMeta?.originalId || node.person.id}
                    </span>
                  )}
                  {node.person.branchMeta && node.person.branchMeta.type !== 'main' && !node.person.branchMeta.isVirtualContainer && (
                    <span
                      className={`branch-source-badge branch-${node.person.branchMeta.type}`}
                      title={node.person.branchMeta.treeName}
                    >
                      {node.person.branchMeta.type === 'daughter-branch' ? '🧬' : node.person.branchMeta.type === 'brother-branch' ? '🤝' : '🌿'}
                    </span>
                  )}
                  <div className="visual-card-header-actions" onClick={(e) => e.stopPropagation()}>
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
                    <button
                      type="button"
                      className="visual-node-options-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectPerson(node.person)
                        openActionModal(node.person)
                      }}
                      title="خيارات وتفاصيل الشخص"
                      aria-label="خيارات"
                    >
                      ⋯
                    </button>
                  </div>
                </div>

                <div className="visual-card-name" dir="auto" title={node.person.name}>
                  {node.person.name}
                </div>

                {node.person.wives && node.person.wives.length > 0 && (
                  <div className="visual-card-wives">
                    {node.person.wives.map((wife, idx) => {
                      const linkedFemale = resolveWife(wife, root)
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
                      return <span key={idx}>⚭ {wifeShortLabel(wife, root)}</span>
                    })}
                  </div>
                )}

                {!isMale && (() => {
                  const fInfo = femalesRelationsMap.get(node.person.id)
                  if (!fInfo || (fInfo.husbands.length === 0 && fInfo.sons.length === 0)) return null
                  return (
                    <div className="visual-card-female-relations">
                      {fInfo.husbands.length > 0 && (
                        <div
                          className="visual-card-husband"
                          title={`زوجها: ${fInfo.husbands.map((h) => h.name).join('، ')}`}
                        >
                          ⚭ {fInfo.husbands.map((h) => h.name).join('، ')}
                        </div>
                      )}
                      {fInfo.sons.length > 0 && (
                        <div
                          className="visual-card-sons"
                          title={`أبناؤها (${fInfo.sons.length}): ${fInfo.sons.map((s) => s.name).join('، ')}`}
                        >
                          👦 {fInfo.sons.length === 1 ? fInfo.sons[0].name : `${fInfo.sons.slice(0, 2).map((s) => s.name).join('، ')}${fInfo.sons.length > 2 ? '…' : ''}`}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            )
          })}

          {/* Linked Spouse Cards (husband of daughter-branch) */}
          {layout.nodes.filter((n) => n.spouseNode).map((node) => {
            const sp = node.spouseNode!
            const isSpouseMatch = activeMatch && activeMatch.id === sp.person.id
            const isSpouseSearchResult = !isSpouseMatch && matches.some((m) => m.id === sp.person.id)
            return (
              <div
                key={`spouse-card-${sp.person.id}`}
                className={`visual-node-card card-m card-branch spouse-card${
                  isSpouseMatch ? ' is-match' : isSpouseSearchResult ? ' is-search-result' : ''
                }`}
                style={{
                  position: 'absolute',
                  left: `${sp.x - CARD_WIDTH / 2}px`,
                  top: `${sp.y}px`,
                  width: `${CARD_WIDTH}px`,
                  minHeight: `${CARD_HEIGHT}px`,
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectPerson(sp.person)
                  openActionModal(sp.person)
                }}
              >
                <div className="visual-card-header">
                  <span className="badge badge-m">
                    {sp.person.branchMeta?.originalId || sp.person.id}
                  </span>
                  {sp.person.branchMeta && sp.person.branchMeta.type !== 'main' && (
                    <span
                      className={`branch-source-badge branch-${sp.person.branchMeta.type}`}
                      title={sp.person.branchMeta.treeName}
                    >
                      🧬
                    </span>
                  )}
                </div>
                <div className="visual-card-name" dir="auto" title={sp.person.name}>
                  {sp.person.name}
                </div>
                <div className="visual-card-wives">
                  <span>⚭ زوج {node.person.name}</span>
                </div>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span className={`badge badge-${actionPerson.gender.toLowerCase()}`}>
                    {actionPerson.id}
                  </span>
                  <span className="person-gender-tag">
                    {actionPerson.gender === 'M' ? 'ذكر' : 'أنثى'}
                  </span>
                  {effectiveEditMode && (
                    <span className="person-mode-tag edit-mode">وضع التعديل ✏️</span>
                  )}
                </div>
                <h3 className="modal-title">{actionPerson.name}</h3>
                <p className="modal-lineage-text">
                  سلسلة الأجداد: {getLineageText(root, actionPerson.id)}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {modalTab !== 'info' && modalTab !== 'options' && (
                  <button
                    type="button"
                    className="modal-back-btn"
                    onClick={() => setModalTab('options')}
                    title="رجوع للخيارات"
                  >
                    ←
                  </button>
                )}
                {modalTab === 'options' && (
                  <button
                    type="button"
                    className="modal-back-btn"
                    onClick={() => setModalTab('info')}
                    title="عرض بطاقة المعلومات"
                  >
                    ℹ️ بطاقة المعلومات
                  </button>
                )}
                {modalTab === 'info' && effectiveEditMode && (
                  <button
                    type="button"
                    className="modal-back-btn"
                    onClick={() => setModalTab('options')}
                    title="خيارات التعديل"
                  >
                    ⚙️ خيارات التعديل
                  </button>
                )}
                <button
                  type="button"
                  className="modal-close-btn"
                  onClick={closeActionModal}
                  title="إغلاق"
                >
                  ×
                </button>
              </div>
            </div>

            {/* ── Person Info Card Tab (When viewing or requested) ── */}
            {modalTab === 'info' && (
              <div className="person-info-card">
                {/* Full Lineage */}
                <div className="person-info-section">
                  <div className="person-info-section-title">
                    <span>📜</span>
                    <span>سلسلة النسب الكاملة</span>
                  </div>
                  <p className="person-info-lineage-text">
                    {lineageChain || actionPerson.name}
                  </p>
                </div>

                {/* Parents (Father & Mother) */}
                <div className="person-info-grid">
                  <div className="person-info-section">
                    <div className="person-info-section-title">
                      <span>👤</span>
                      <span>الوالد</span>
                    </div>
                    {parent ? (
                      parent.branchMeta?.isVirtualContainer ? (
                        <button
                          type="button"
                          className="person-info-nav-pill male-pill"
                          onClick={() => {
                            const path = findPathToNode(root, parent.id)
                            setExpandedIds((prev) => {
                              const next = new Set(prev)
                              path.forEach((id) => next.add(id))
                              return next
                            })
                            onSelectPerson(parent)
                            openActionModal(parent)
                          }}
                          title="انتقال إلى بطاقة الأب المشترك"
                        >
                          🤝 {parent.branchMeta?.personName || parent.name} (أب مشترك · إخوة) ↗
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="person-info-nav-pill male-pill"
                          onClick={() => {
                            const path = findPathToNode(root, parent.id)
                            setExpandedIds((prev) => {
                              const next = new Set(prev)
                              path.forEach((id) => next.add(id))
                              return next
                            })
                            onSelectPerson(parent)
                            openActionModal(parent)
                          }}
                          title="انتقال إلى بطاقة الوالد"
                        >
                          {parent.name} ({parent.branchMeta?.originalId || parent.id}) ↗
                        </button>
                      )
                    ) : (
                      <span className="person-info-muted">الجد الأعلى للمشجر</span>
                    )}
                  </div>

                  <div className="person-info-section">
                    <div className="person-info-section-title">
                      <span>🌸</span>
                      <span>الوالدة (الأم)</span>
                    </div>
                    {motherName ? (
                      <span className="person-info-val-highlight">{motherName}</span>
                    ) : (
                      <span className="person-info-muted">غير مسجلة</span>
                    )}
                  </div>
                </div>

                {/* Wives (for Male) */}
                {actionPerson.gender === 'M' && (
                  <div className="person-info-section">
                    <div className="person-info-section-title">
                      <span>💍</span>
                      <span>الزوجات ({wivesInfo.length})</span>
                    </div>
                    {wivesInfo.length === 0 ? (
                      <span className="person-info-muted">لم تُسجل زوجات</span>
                    ) : (
                      <div className="person-info-wives-list">
                        {wivesInfo.map((item, idx) => (
                          <div key={idx} className="person-info-wife-row">
                            <span className="person-info-bullet">⚭</span>
                            <div className="person-info-wife-content">
                              <div className="person-info-wife-name">
                                {item.resolved ? (
                                  <button
                                    type="button"
                                    className="person-info-nav-link"
                                    onClick={() => {
                                      const path = findPathToNode(root, item.resolved!.id)
                                      setExpandedIds((prev) => {
                                        const next = new Set(prev)
                                        path.forEach((id) => next.add(id))
                                        return next
                                      })
                                      onSelectPerson(item.resolved!)
                                      openActionModal(item.resolved!)
                                    }}
                                  >
                                    🔗 {item.fullLabel || item.shortLabel} ↗
                                  </button>
                                ) : (
                                  <span>{item.fullLabel || item.shortLabel}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Husbands (for Female) */}
                {actionPerson.gender === 'F' && (
                  <div className="person-info-section">
                    <div className="person-info-section-title">
                      <span>💍</span>
                      <span>الزوج {femaleRelations && femaleRelations.husbands.length > 0 ? `(${femaleRelations.husbands.length})` : ''}</span>
                    </div>
                    {(!femaleRelations || femaleRelations.husbands.length === 0) ? (
                      <span className="person-info-muted">لم يُسجل زوج</span>
                    ) : (
                      <div className="person-info-pill-list">
                        {femaleRelations.husbands.map((husband) => (
                          <button
                            key={husband.id}
                            type="button"
                            className="person-info-nav-pill male-pill"
                            onClick={() => {
                              const path = findPathToNode(root, husband.id)
                              setExpandedIds((prev) => {
                                const next = new Set(prev)
                                path.forEach((id) => next.add(id))
                                return next
                              })
                              onSelectPerson(husband)
                              openActionModal(husband)
                            }}
                            title="انتقال إلى بطاقة الزوج"
                          >
                            ⚭ {husband.name} ({husband.branchMeta?.originalId || husband.id}) ↗
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Children: Sons & Daughters */}
                <div className="person-info-section">
                  <div className="person-info-section-title">
                    <span>{actionPerson.branchMeta?.isVirtualContainer ? '🤝' : '🌱'}</span>
                    <span>
                      {actionPerson.branchMeta?.isVirtualContainer
                        ? `الإخوة وفروع العائلة المدمجة (${actionPerson.children.length})`
                        : `الذرية والأبناء (${sons.length + daughters.length})`}
                    </span>
                  </div>

                  {sons.length + daughters.length === 0 ? (
                    <span className="person-info-muted">لا يوجد أبناء مسجلين</span>
                  ) : (
                    <div className="person-info-children-wrap">
                      {sons.length > 0 && (
                        <div className="person-info-child-group">
                          <span className="person-info-sublabel">
                            {actionPerson.branchMeta?.isVirtualContainer ? 'الإخوة (أصول الأشجار):' : `الأبناء (${sons.length}):`}
                          </span>
                          <div className="person-info-pill-list">
                            {sons.map((son) => (
                              <button
                                key={son.id}
                                type="button"
                                className="person-info-nav-pill male-pill"
                                onClick={() => {
                                  const path = findPathToNode(root, son.id)
                                  setExpandedIds((prev) => {
                                    const next = new Set(prev)
                                    path.forEach((id) => next.add(id))
                                    return next
                                  })
                                  onSelectPerson(son)
                                  openActionModal(son)
                                }}
                              >
                                {son.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {daughters.length > 0 && (
                        <div className="person-info-child-group">
                          <span className="person-info-sublabel">البنات ({daughters.length}):</span>
                          <div className="person-info-pill-list">
                            {daughters.map((daughter) => (
                              <button
                                key={daughter.id}
                                type="button"
                                className="person-info-nav-pill female-pill"
                                onClick={() => {
                                  const path = findPathToNode(root, daughter.id)
                                  setExpandedIds((prev) => {
                                    const next = new Set(prev)
                                    path.forEach((id) => next.add(id))
                                    return next
                                  })
                                  onSelectPerson(daughter)
                                  openActionModal(daughter)
                                }}
                              >
                                {daughter.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Action Buttons in Info Mode */}
                <div className="person-info-footer-actions">
                  <button
                    type="button"
                    className="modal-action-btn primary-action"
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

                  {effectiveEditMode ? (
                    <button
                      type="button"
                      className="modal-action-btn"
                      onClick={() => setModalTab('options')}
                    >
                      ⚙️ خيارات التعديل والإضافة
                    </button>
                  ) : onRequestEditUnlock ? (
                    <button
                      type="button"
                      className="modal-action-btn"
                      onClick={() => {
                        closeActionModal()
                        onRequestEditUnlock()
                      }}
                    >
                      ✏️ تعديل هذا الشخص (يتطلب الرمز)
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            {modalTab === 'options' && (
              <div className="modal-options-list">
                <button
                  type="button"
                  className="modal-action-btn"
                  onClick={() => setModalTab('info')}
                  style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' }}
                >
                  ℹ️ عرض بطاقة المعلومات والنسب الكامل
                </button>
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

                {(() => {
                  const isVirtualRoot = Boolean(actionPerson.branchMeta?.isVirtualContainer)
                  const isOtherBranch = Boolean(
                    isUnifiedView &&
                    actionPerson.branchMeta &&
                    actionPerson.branchMeta.type !== 'main' &&
                    !actionPerson.branchMeta.isVirtualContainer
                  )
                  const canEditThisPerson = !isVirtualRoot && !isOtherBranch

                  return (
                    <>
                      {actionPerson.gender === 'M' && canEditThisPerson && (
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

                      {actionPerson.gender === 'F' && onLinkBranchForPerson && canEditThisPerson && (
                        <button
                          type="button"
                          className="modal-action-btn primary-action"
                          onClick={() => {
                            closeActionModal()
                            onLinkBranchForPerson(actionPerson)
                          }}
                        >
                          🧬 ربط فرع أو شجرة لهذه البنت (أبناؤها وذريتها)
                        </button>
                      )}

                      {isOtherBranch && actionPerson.branchMeta && (
                        <p className="modal-branch-note">
                          🔗 هذا الشخص من شجرة «{actionPerson.branchMeta.treeName}» — افتحها للتعديل.
                        </p>
                      )}

                      {canEditThisPerson && (
                        <button
                          type="button"
                          className="modal-action-btn"
                          onClick={() => setModalTab('rename')}
                        >
                          ✏️ تعديل اسم الشخص
                        </button>
                      )}
                    </>
                  )
                })()}


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
                    {actionPerson.wives.map((wife, idx) => {
                      const linked = resolveWife(wife, root)
                      const fullLineage = wifeLineageFullLabel(wife, root, 4)
                      return (
                        <li key={idx} className="wife-manage-item">
                          <span>
                            {linked ? (
                              <span className="wife-link-tag">
                                🔗 {fullLineage || `${linked.name} (${linked.id})`}
                              </span>
                            ) : (
                              `⚭ ${fullLineage || wifeShortLabel(wife, root)}`
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

                <div className="modal-field" style={{ marginTop: '14px' }}>
                  <label style={{ fontWeight: 700, marginBottom: '6px' }}>
                    اختر وربط زوجة من نساء القبيلة:
                  </label>

                  <div className="tribe-wife-search-box">
                    <div className="tribe-wife-search-input-row">
                      <input
                        type="search"
                        dir="rtl"
                        className="tribe-wife-search-input"
                        placeholder="ابحث باسم البنت أو والدها أو المعرف (مثال: فاطمة، أحمد، F561)..."
                        value={tribeSearchQuery}
                        onChange={(e) => setTribeSearchQuery(e.target.value)}
                      />
                      <button
                        type="button"
                        className="tribe-wife-cross-btn"
                        onClick={() => setShowTreeWifePicker(true)}
                        title="اختيار من شجرة عائلية أخرى"
                      >
                        🌐 شجرة أخرى
                      </button>
                    </div>

                    <div className="tribe-wife-results-list">
                      {filteredTreeFemales.length === 0 ? (
                        <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
                          {tribeSearchQuery ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد نساء متاحة للربط'}
                        </div>
                      ) : (
                        filteredTreeFemales.map((item) => (
                          <div key={item.female.id} className="tribe-wife-result-item">
                            <div className="tribe-wife-info">
                              <div className="tribe-wife-name-row">
                                <span className="tribe-wife-name">{item.female.name}</span>
                                <span className="badge badge-f">{item.female.id}</span>
                              </div>
                              <span className="tribe-wife-lineage" title={item.lineage}>
                                {item.lineage}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="tribe-wife-link-btn"
                              onClick={() => {
                                if (onAddWife) {
                                  onAddWife(actionPerson.id, createTreeWife(item.female.id))
                                  setTribeSearchQuery('')
                                }
                              }}
                            >
                              ➕ ربط كزوجة
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="modal-field" style={{ marginTop: '12px' }}>
                  <label style={{ fontWeight: 700, marginBottom: '6px' }}>
                    أو أدخل زوجة من خارج القبيلة:
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <input
                      type="text"
                      dir="rtl"
                      placeholder="اسم الزوجة..."
                      value={newWifeName}
                      onChange={(e) => setNewWifeName(e.target.value)}
                    />
                    <input
                      type="text"
                      dir="rtl"
                      placeholder="العائلة أو القبيلة (اختياري)..."
                      value={newWifeFamily}
                      onChange={(e) => setNewWifeFamily(e.target.value)}
                    />
                    <input
                      type="text"
                      dir="rtl"
                      placeholder="نبذة عن الزوجة (اختياري)..."
                      value={newWifeTribute}
                      onChange={(e) => setNewWifeTribute(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary"
                      disabled={!newWifeName.trim()}
                      onClick={() => {
                        if (newWifeName.trim() && onAddWife) {
                          onAddWife(
                            actionPerson.id,
                            createExternalWife(newWifeName, newWifeFamily, newWifeTribute),
                          )
                          setNewWifeName('')
                          setNewWifeFamily('')
                          setNewWifeTribute('')
                        }
                      }}
                    >
                      إضافة زوجة من الخارج
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

      {/* Cross-tree wife picker dialog */}
      {showTreeWifePicker && actionPerson && (
        <TreeWifePicker
          root={root}
          linkedIds={linkedFemaleIds}
          currentTreeId={currentTreeId}
          currentTreeName={currentTreeName}
          availableTrees={availableTrees}
          onSelect={(personId, extra) => {
            if (onAddWife) {
              onAddWife(actionPerson.id, createTreeWife(personId, extra))
            }
            setShowTreeWifePicker(false)
          }}
          onCreateAndLink={() => null}
          onCancel={() => setShowTreeWifePicker(false)}
        />
      )}
    </div>
  )
}
