import { memo, useCallback, useDeferredValue, useMemo, useState, useRef, useEffect } from 'react'
import type { Person, TreeMeta, Wife } from '../types'
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
  onRenamePerson?: (personId: string, name: string) => void
  onAddChildrenBatch?: (personId: string, sons: string[], daughters: string[]) => void
  onDeletePerson?: (personId: string) => void
  onAddWife?: (personId: string, wife: Wife) => void
  onRemoveWife?: (personId: string, index: number) => void
  onLinkBranchForPerson?: (person: Person) => void
  onOpenTree?: (treeId: string, personId?: string) => void
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

const CARD_WIDTH = 172
const CARD_HEIGHT = 104
const NODE_GAP = 28
const LEVEL_HEIGHT = 148
const SPOUSE_GAP = 14
const MAX_VISIBLE_WIVES = 2
const SEARCH_RESULTS_LIMIT = 8

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

/**
 * The chart canvas is split into memoized layers. The chart holds a lot of
 * transient UI state (rename text, search text, modal fields); if the cards
 * were rendered inline, every keystroke or selection would re-render thousands
 * of cards and make the editor feel laggy. Memoizing the links layer and each
 * individual card means only the pieces that actually changed are re-rendered.
 */

type FemalesRelationsMap = ReturnType<typeof getAllFemalesRelations>
type FemaleRelationInfo = FemalesRelationsMap extends Map<string, infer V> ? V : never

function renderWifeTagsFor(
  person: Person,
  root: Person,
  onSelectPerson: (person: Person) => void,
  onOpenTree: ((treeId: string, personId?: string) => void) | undefined,
  setExpandedIds: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const seen = new Set<string>()
  const wives: { wife: Wife; linkedFemale: Person | null }[] = []

  for (const wife of person.wives || []) {
    const linkedFemale = resolveWife(wife, root)
    const key = linkedFemale
      ? `person:${linkedFemale.id}`
      : wife.type === 'tree'
        ? `tree:${wife.treeId || ''}:${wife.personId || wife.id}`
        : `external:${wife.id}`
    if (seen.has(key)) continue
    seen.add(key)
    wives.push({ wife, linkedFemale })
  }

  if (wives.length === 0) return null

  const visibleWives = wives.slice(0, MAX_VISIBLE_WIVES)
  const hiddenWifeCount = wives.length - visibleWives.length

  return (
    <div className="visual-card-wives">
      {visibleWives.map(({ wife, linkedFemale }, idx) => {
        const wifeTreeName = wife.type === 'tree' ? wife.treeName : undefined
        const wifeTreeId = wife.type === 'tree' ? wife.treeId : undefined
        if (linkedFemale) {
          const displayId = linkedFemale.branchMeta?.originalId || linkedFemale.id
          const treeLabel = wifeTreeName || linkedFemale.branchMeta?.treeName
          // A wife is only "cross-tree" when she comes from a different tree
          // than her husband. A branch man's wife from the same branch must
          // stay a plain link, not be labelled as another tree's wife.
          const husbandTreeId = person.branchMeta?.treeId
          const linkedTreeId = linkedFemale.branchMeta?.treeId
          const isCrossTree = Boolean(
            (wifeTreeId && wifeTreeId !== husbandTreeId) ||
              (linkedFemale.branchMeta &&
                linkedFemale.branchMeta.type !== 'main' &&
                linkedTreeId !== husbandTreeId),
          )
          const icon = isCrossTree ? '🌳' : '🔗'
          const tooltip = treeLabel
            ? `زوجة من شجرة (${treeLabel}): ${linkedFemale.name} (${displayId}) - انقر للانتقال إليها`
            : `زوجة من السجل: ${linkedFemale.name} (${displayId}) - انقر للانتقال إليها`

          return (
            <span
              key={`${wife.id}-${idx}`}
              className={`wife-link-tag ${isCrossTree ? 'wife-cross-tree-tag' : ''}`}
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
              title={tooltip}
            >
              {icon} {linkedFemale.name}
              {isCrossTree && treeLabel ? ` — ${treeLabel}` : ` (${displayId})`}
            </span>
          )
        }

        if (wife.type === 'tree') {
          const treeLabel = wife.treeName || 'شجرة أخرى'
          const displayName = wife.personName || wife.personId
          const tooltip = wife.lineageLabel
            ? `${wife.lineageLabel} [من: ${treeLabel}]`
            : `زوجة من: ${treeLabel} (${wife.personId})`
          const canClick = Boolean(wife.treeId && onOpenTree)

          return (
            <span
              key={`${wife.id}-${idx}`}
              className={`wife-link-tag wife-cross-tree-tag ${canClick ? 'is-clickable' : ''}`}
              onClick={(e) => {
                if (canClick && wife.treeId) {
                  e.stopPropagation()
                  onOpenTree!(wife.treeId, wife.personId)
                }
              }}
              title={canClick ? `${tooltip} - انقر لفتح شجرتها` : tooltip}
            >
              🌳 {displayName} [{treeLabel}]
            </span>
          )
        }

        return (
          <span key={`${wife.id}-${idx}`} className="wife-link-tag wife-external-tag">
            ⚭ {wifeShortLabel(wife, root)}
          </span>
        )
      })}
      {hiddenWifeCount > 0 && (
        <span
          className="wife-more-tag"
          title={`زوجات أخريات: ${wives
            .slice(MAX_VISIBLE_WIVES)
            .map(({ wife, linkedFemale }) => {
              if (linkedFemale) return linkedFemale.name
              return wife.type === 'tree' ? wife.personName || 'زوجة' : wife.name || 'زوجة'
            })
            .join('، ')}`}
        >
          +{hiddenWifeCount}
        </span>
      )}
    </div>
  )
}

interface TreeLinksLayerProps {
  layout: ReturnType<typeof computeTreeLayout>
  zoom: number
}

const TreeLinksLayer = memo(function TreeLinksLayer({ layout, zoom }: TreeLinksLayerProps) {
  return (
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
  )
})

interface TreeNodeCardProps {
  person: Person
  x: number
  y: number
  hasChildren: boolean
  isExpanded: boolean
  isSelected: boolean
  isCurrent: boolean
  isMatch: boolean
  isSearchResult: boolean
  compact: boolean
  root: Person
  femaleRelations: FemaleRelationInfo | undefined
  onSelectPerson: (person: Person) => void
  openActionModal: (person: Person) => void
  toggleExpand: (personId: string, event?: React.MouseEvent) => void
  onOpenTree?: (treeId: string, personId?: string) => void
  setExpandedIds: React.Dispatch<React.SetStateAction<Set<string>>>
}

const TreeNodeCard = memo(function TreeNodeCard({
  person,
  x,
  y,
  hasChildren,
  isExpanded,
  isSelected,
  isCurrent,
  isMatch,
  isSearchResult,
  compact,
  root,
  femaleRelations,
  onSelectPerson,
  openActionModal,
  toggleExpand,
  onOpenTree,
  setExpandedIds,
}: TreeNodeCardProps) {
  const isMale = person.gender === 'M'
  const open = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelectPerson(person)
    openActionModal(person)
  }

  return (
    <div
      className={`visual-node-card ${isMale ? 'card-m' : 'card-f'}${
        isSelected ? ' is-selected' : ''
      }${isCurrent ? ' is-current' : ''}${isMatch ? ' is-match' : isSearchResult ? ' is-search-result' : ''}${
        compact ? ' compact-mode' : ''
      }${person.branchMeta && person.branchMeta.type !== 'main' ? ' card-branch' : ''}${
        person.branchMeta?.isVirtualContainer ? ' card-virtual-root' : ''
      }`}
      style={{
        position: 'absolute',
        left: `${x - CARD_WIDTH / 2}px`,
        top: `${y}px`,
        width: `${CARD_WIDTH}px`,
        height: `${CARD_HEIGHT}px`,
      }}
      onClick={open}
      onDoubleClick={open}
    >
      <div className="visual-card-header">
        {!person.branchMeta?.isVirtualContainer && (
          <span className={`badge badge-${person.gender.toLowerCase()}`}>
            {person.branchMeta?.originalId || person.id}
          </span>
        )}
        {person.branchMeta && person.branchMeta.type !== 'main' && !person.branchMeta.isVirtualContainer && (
          <span
            className={`branch-source-badge branch-${person.branchMeta.type}`}
            title={person.branchMeta.treeName}
          >
            {person.branchMeta.type === 'daughter-branch' ? '🧬' : person.branchMeta.type === 'brother-branch' ? '🤝' : '🌿'}
          </span>
        )}
        <div className="visual-card-header-actions" onClick={(e) => e.stopPropagation()}>
          {hasChildren && (
            <button
              type="button"
              className="visual-toggle-btn"
              onClick={(e) => toggleExpand(person.id, e)}
              title={isExpanded ? 'طي الفروع' : 'توسيع الفروع'}
            >
              {isExpanded ? '−' : `+ ${person.children.length}`}
            </button>
          )}
          <button
            type="button"
            className="visual-node-options-btn"
            onClick={(e) => {
              e.stopPropagation()
              onSelectPerson(person)
              openActionModal(person)
            }}
            title="خيارات وتفاصيل الشخص"
            aria-label="خيارات"
          >
            ⋯
          </button>
        </div>
      </div>

      <div className="visual-card-name" dir="auto" title={person.name}>
        {person.name}
      </div>

      {renderWifeTagsFor(person, root, onSelectPerson, onOpenTree, setExpandedIds)}

      {!isMale && (() => {
        const fInfo = femaleRelations
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
})

interface SpouseCardProps {
  spouse: Person
  partnerName: string
  x: number
  y: number
  isMatch: boolean
  isSearchResult: boolean
  root: Person
  onSelectPerson: (person: Person) => void
  openActionModal: (person: Person) => void
  onOpenTree?: (treeId: string, personId?: string) => void
  setExpandedIds: React.Dispatch<React.SetStateAction<Set<string>>>
}

const SpouseCard = memo(function SpouseCard({
  spouse,
  partnerName,
  x,
  y,
  isMatch,
  isSearchResult,
  root,
  onSelectPerson,
  openActionModal,
  onOpenTree,
  setExpandedIds,
}: SpouseCardProps) {
  return (
    <div
      className={`visual-node-card card-m card-branch spouse-card${
        isMatch ? ' is-match' : isSearchResult ? ' is-search-result' : ''
      }`}
      style={{
        position: 'absolute',
        left: `${x - CARD_WIDTH / 2}px`,
        top: `${y}px`,
        width: `${CARD_WIDTH}px`,
        height: `${CARD_HEIGHT}px`,
      }}
      onClick={(e) => {
        e.stopPropagation()
        onSelectPerson(spouse)
        openActionModal(spouse)
      }}
    >
      <div className="visual-card-header">
        <span className="badge badge-m">
          {spouse.branchMeta?.originalId || spouse.id}
        </span>
        {spouse.branchMeta && spouse.branchMeta.type !== 'main' && (
          <span
            className={`branch-source-badge branch-${spouse.branchMeta.type}`}
            title={spouse.branchMeta.treeName}
          >
            🧬
          </span>
        )}
      </div>
      <div className="visual-card-name" dir="auto" title={spouse.name}>
        {spouse.name}
      </div>
      {spouse.wives && spouse.wives.length > 0 ? (
        renderWifeTagsFor(spouse, root, onSelectPerson, onOpenTree, setExpandedIds)
      ) : (
        <div className="visual-card-wives">
          <span>⚭ زوج {partnerName}</span>
        </div>
      )}
    </div>
  )
})

/**
 * Renders the connector lines and the person/spouse cards.
 *
 * This is deliberately a memoized child component: the chart keeps a lot of
 * transient UI state (rename text, search text, modal fields). If the cards
 * were rendered inline, every keystroke would re-render thousands of cards and
 * make editing feel laggy. With memoized cards, typing only re-renders the
 * small subtree that actually changed.
 */
interface TreeNodesLayerProps {
  layout: ReturnType<typeof computeTreeLayout>
  zoom: number
  selectedId: string | null
  currentId: string | null
  activeMatch: Person | null
  matchIds: Set<string>
  root: Person
  femalesRelationsMap: ReturnType<typeof getAllFemalesRelations>
  onSelectPerson: (person: Person) => void
  openActionModal: (person: Person) => void
  toggleExpand: (personId: string, event?: React.MouseEvent) => void
  onOpenTree?: (treeId: string, personId?: string) => void
  setExpandedIds: React.Dispatch<React.SetStateAction<Set<string>>>
}

const TreeNodesLayer = memo(function TreeNodesLayer({
  layout,
  zoom,
  selectedId,
  currentId,
  activeMatch,
  matchIds,
  root,
  femalesRelationsMap,
  onSelectPerson,
  openActionModal,
  toggleExpand,
  onOpenTree,
  setExpandedIds,
}: TreeNodesLayerProps) {
  return (
    <>
      <TreeLinksLayer layout={layout} zoom={zoom} />

      {/* Node Cards */}
      {layout.nodes.map((node) => {
        const isMatch = Boolean(activeMatch && activeMatch.id === node.person.id)
        return (
          <TreeNodeCard
            key={node.person.id}
            person={node.person}
            x={node.x}
            y={node.y}
            hasChildren={node.hasChildren}
            isExpanded={node.isExpanded}
            isSelected={selectedId === node.person.id}
            isCurrent={currentId === node.person.id}
            isMatch={isMatch}
            isSearchResult={!isMatch && matchIds.has(node.person.id)}
            compact={zoom < 0.45}
            root={root}
            femaleRelations={femalesRelationsMap.get(node.person.id)}
            onSelectPerson={onSelectPerson}
            openActionModal={openActionModal}
            toggleExpand={toggleExpand}
            onOpenTree={onOpenTree}
            setExpandedIds={setExpandedIds}
          />
        )
      })}

      {/* Linked Spouse Cards (husband of daughter-branch) */}
      {layout.nodes.filter((n) => n.spouseNode).map((node) => {
        const sp = node.spouseNode!
        const isMatch = Boolean(activeMatch && activeMatch.id === sp.person.id)
        return (
          <SpouseCard
            key={`spouse-card-${sp.person.id}`}
            spouse={sp.person}
            partnerName={node.person.name}
            x={sp.x}
            y={sp.y}
            isMatch={isMatch}
            isSearchResult={!isMatch && matchIds.has(sp.person.id)}
            root={root}
            onSelectPerson={onSelectPerson}
            openActionModal={openActionModal}
            onOpenTree={onOpenTree}
            setExpandedIds={setExpandedIds}
          />
        )
      })}
    </>
  )
})

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
  onRenamePerson,
  onAddChildrenBatch,
  onDeletePerson,
  onAddWife,
  onRemoveWife,
  onLinkBranchForPerson,
  onOpenTree,
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
  // Keep the input responsive: the expensive match scan runs against the
  // deferred value so a keystroke paints before the whole tree is searched.
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const [matchIndex, setMatchIndex] = useState(0)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const searchBoxRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Close the results panel when the user clicks elsewhere on the chart.
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!searchBoxRef.current?.contains(event.target as Node)) {
        setIsSearchOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  // "/" (or Ctrl/Cmd+K) jumps straight into tree search without stealing
  // keystrokes from inputs, the editor modal, or other dialogs.
  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const isTyping =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (isTyping || document.querySelector('.modal-backdrop')) return
      if (event.key === '/' || (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey))) {
        event.preventDefault()
        searchInputRef.current?.focus()
        setIsSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [])

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

  useEffect(() => {
    if (effectiveEditMode) return
    setModalTab('info')
    setShowTreeWifePicker(false)
  }, [effectiveEditMode])

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
    const set = new Set<string>()
    for (const w of actionPerson.wives) {
      if (w.type === 'tree') {
        const resolved = resolveWife(w, root)
        if (resolved) {
          set.add(resolved.id)
        } else if (!w.treeId || w.treeId === currentTreeId) {
          if (w.personId) set.add(w.personId)
        }
      }
    }
    return set
  }, [actionPerson?.wives, root, currentTreeId])

  const searchableTreeFemales = useMemo(() => {
    // This list is only visible inside the wives tab. Building lineage labels
    // for every female in a 2,000+ person tree on every chart render was the
    // main cost of switching the unified view on.
    if (modalTab !== 'wives') return []
    const list = collectFemales(root)
    return list.map((female) => {
      const lineage = getLineageText(root, female.id)
      return {
        female,
        lineage,
        isLinked: linkedFemaleIds.has(female.id),
      }
    })
  }, [root, linkedFemaleIds, modalTab])

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

  // The unified view wraps the real family root in a synthetic "محمد" node.
  // Center on the real main branch, not the virtual container.
  const focusRootNode = useMemo(
    () =>
      layout.nodes.find(
        (node) =>
          node.person.branchMeta?.type === 'main' &&
          !node.person.branchMeta.isVirtualContainer,
      ) ??
      layout.nodes.find((node) => node.person.id === root.id) ??
      layout.nodes[0],
    [layout, root.id],
  )

  // Find search matches across the whole tree.
  //
  // Multi-word queries are treated as a name/nasab chain. When the query uses
  // a connector such as "بن", "بنت", "ولد" or "منت", each part is matched
  // separately against the person's name and their ancestors, in order. The
  // closest generation is preferred: "X بن Y" finds X's father Y first, and
  // only searches further up the line if there is no closer match. This also
  // lets "X بن Y" find X whose third grandfather is Y.
  //
  // Single-word queries keep the names-first ranking.
  const matches = useMemo(() => {
    if (!deferredSearchQuery.trim()) return []
    const q = searchable(deferredSearchQuery)
    if (!q) return []
    const rawTokens = q.split(/\s+/).filter(Boolean)
    const connectors = new Set(['بن', 'ابن', 'بنت', 'ابنه', 'ولد', 'منت'])
    const feminineConnectors = new Set(['بنت', 'ابنه', 'منت'])
    // Filter out genealogy connectors unless they are the only search token
    const filteredTokens = rawTokens.filter((t) => !connectors.has(t) && t !== 'ال')
    const searchTerms = filteredTokens.length > 0 ? filteredTokens : rawTokens

    // Split "حمود بن محمد سالم" into [["حمود"], ["محمد", "سالم"]].
    const segments: string[][] = []
    let currentSegment: string[] = []
    for (const token of rawTokens) {
      if (connectors.has(token)) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment)
          currentSegment = []
        }
      } else if (token !== 'ال') {
        currentSegment.push(token)
      }
    }
    if (currentSegment.length > 0) segments.push(currentSegment)

    const startsWithName =
      rawTokens.length > 0 && !connectors.has(rawTokens[0]) && rawTokens[0] !== 'ال'
    const firstConnector = rawTokens.find((token) => connectors.has(token)) ?? null
    const segmentSearch = startsWithName && firstConnector !== null && segments.length >= 2
    const expectedGender = firstConnector
      ? feminineConnectors.has(firstConnector)
        ? 'F'
        : 'M'
      : null
    const chainSearch =
      !segmentSearch && (firstConnector !== null || searchTerms.length >= 2)

    type SearchMatch = {
      person: Person
      score: number
      order: number
      gap: number
      exactness: number
    }
    const found = new Map<string, SearchMatch>()
    const visited = new Set<string>()
    let order = 0

    function tokenize(value: string): string[] {
      return searchable(value)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
    }

    function parseLineageNames(value: string): string[] {
      return value
        .split(/\s+(?:بن|بنت)\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
    }

    function exactWord(term: string, word: string): boolean {
      if (term === word) return true
      const termNoAl = term.startsWith('ال') && term.length > 3 ? term.slice(2) : term
      const wordNoAl = word.startsWith('ال') && word.length > 3 ? word.slice(2) : word
      return termNoAl === wordNoAl
    }

    function wordMatches(term: string, word: string): boolean {
      if (exactWord(term, word)) return true
      const termNoAl = term.startsWith('ال') && term.length > 3 ? term.slice(2) : term
      const wordNoAl = word.startsWith('ال') && word.length > 3 ? word.slice(2) : word
      // Allow a normalized spelling to match a slightly longer word, but do
      // not let "حمود" match "محمود".
      if (termNoAl.length >= 4 && wordNoAl.startsWith(termNoAl)) return true
      if (wordNoAl.length >= 4 && termNoAl.startsWith(wordNoAl)) return true
      return false
    }

    function textMatchesAll(text: string): boolean {
      const words = tokenize(text)
      return searchTerms.every((term) => words.some((word) => wordMatches(term, word)))
    }

    function matchScore(text: string): { exact: boolean; all: boolean; some: boolean } {
      const words = tokenize(text)
      const hits = searchTerms.map((term) => words.some((word) => wordMatches(term, word)))
      const exact =
        words.length === searchTerms.length &&
        searchTerms.every((term, index) => wordMatches(term, words[index]))
      return {
        exact,
        all: hits.every(Boolean),
        some: hits.some(Boolean),
      }
    }

    function sequenceIndex(haystack: string[], needle: string[]): number {
      if (needle.length === 0 || haystack.length < needle.length) return -1
      for (let i = 0; i <= haystack.length - needle.length; i++) {
        let matched = true
        for (let j = 0; j < needle.length; j++) {
          if (!wordMatches(needle[j], haystack[i + j])) {
            matched = false
            break
          }
        }
        if (matched) return i
      }
      return -1
    }

    // Find a query segment inside one person's name. It may start at the first
    // word or later, but the words must be contiguous.
    function findSegmentInName(
      name: string,
      segment: string[],
    ): { start: number; exactWords: number } | null {
      const words = tokenize(name)
      if (segment.length === 0 || words.length < segment.length) return null
      let best: { start: number; exactWords: number } | null = null
      for (let start = 0; start <= words.length - segment.length; start++) {
        let matched = true
        let exactWords = 0
        for (let j = 0; j < segment.length; j++) {
          if (!wordMatches(segment[j], words[start + j])) {
            matched = false
            break
          }
          if (exactWord(segment[j], words[start + j])) exactWords++
        }
        if (matched) {
          const candidate = { start, exactWords }
          if (
            !best ||
            candidate.start < best.start ||
            (candidate.start === best.start && candidate.exactWords > best.exactWords)
          ) {
            best = candidate
          }
        }
      }
      return best
    }

    // Match every query segment to the person's name/ancestors in order. Gaps
    // between matched generations are allowed; smaller gap = closer ancestor.
    function alignPerson(
      person: Person,
      lineageNames: string[],
    ): { gap: number; exactness: number } | null {
      if (segments.length < 2) return null
      const names = lineageNames.length > 0 ? lineageNames : [person.name]
      const firstNameMatch = findSegmentInName(names[0], segments[0])
      if (!firstNameMatch || firstNameMatch.start !== 0) return null

      let previousNameIndex = 0
      let gap = 0
      let exactness = firstNameMatch.exactWords + 1

      for (let s = 1; s < segments.length; s++) {
        let matchedIndex = -1
        let matchedSegment: { start: number; exactWords: number } | null = null
        for (let i = previousNameIndex + 1; i < names.length; i++) {
          const match = findSegmentInName(names[i], segments[s])
          if (match) {
            matchedIndex = i
            matchedSegment = match
            break
          }
        }
        if (matchedIndex === -1 || !matchedSegment) return null
        gap += matchedIndex - previousNameIndex - 1
        exactness += matchedSegment.exactWords + (matchedSegment.start === 0 ? 1 : 0)
        previousNameIndex = matchedIndex
      }

      return { gap, exactness }
    }

    function addMatch(person: Person, score: number, gap = 0, exactness = 0) {
      const existing = found.get(person.id)
      if (!existing) {
        found.set(person.id, { person, score, order: order++, gap, exactness })
      } else if (
        score < existing.score ||
        (score === existing.score &&
          (gap < existing.gap ||
            (gap === existing.gap && exactness > existing.exactness)))
      ) {
        existing.score = score
        existing.gap = gap
        existing.exactness = exactness
      }
    }

    function search(person: Person, ancestors: string[]) {
      if (visited.has(person.id)) return
      visited.add(person.id)

      // In the unified view a linked person is attached through their spouse,
      // so the traversal ancestors can belong to the spouse's family. Use the
      // source tree's biological lineage for ancestor-chain searches.
      const lineageNames =
        person.branchMeta &&
        person.branchMeta.type !== 'main' &&
        person.branchMeta.treeId
          ? parseLineageNames(getLineageText(root, person.id))
          : [person.name, ...ancestors]
      const safeLineageNames = lineageNames.length > 0 ? lineageNames : [person.name]
      const lineageSimple = safeLineageNames.join(' ')
      const lineageBin = safeLineageNames.join(' بن ')
      const lineageWald = safeLineageNames.join(' ولد ')
      const lineageBint = safeLineageNames.join(' بنت ')
      const wivesText = (person.wives || [])
        .map((w) => (w.type === 'tree' ? (w.personName || '') : (w.name || '')))
        .join(' ')
      const metaText = person.branchMeta?.personName || person.branchMeta?.treeName || ''
      const rawText = `${person.name} ${person.id} ${person.branchMeta?.originalId || ''} ${metaText} ${lineageSimple} ${lineageBin} ${lineageWald} ${lineageBint} ${wivesText}`
      const fullMatch = textMatchesAll(rawText)
      const nameMatch = matchScore(person.name)
      const wifeMatch = matchScore(wivesText)

      if (segmentSearch) {
        const alignment = alignPerson(person, safeLineageNames)
        if (alignment) {
          addMatch(person, 0, alignment.gap, alignment.exactness)
        } else if (fullMatch) {
          // Keep a loose fallback only for when no ordered ancestor match exists.
          const score = nameMatch.exact
            ? 1
            : nameMatch.all
              ? 2
              : nameMatch.some
                ? 3
                : wifeMatch.all || wifeMatch.some
                  ? 4
                  : 5
          addMatch(person, score, Number.MAX_SAFE_INTEGER, 0)
        }
      } else if (chainSearch) {
        const chainIndex = sequenceIndex(tokenize(lineageSimple), searchTerms)
        if (chainIndex === 0) {
          addMatch(person, 0)
        } else if (chainIndex > 0) {
          addMatch(person, 1)
        } else if (fullMatch) {
          const score = nameMatch.exact
            ? 2
            : nameMatch.all
              ? 3
              : nameMatch.some
                ? 4
                : wifeMatch.all || wifeMatch.some
                  ? 5
                  : 6
          addMatch(person, score)
        }
      } else if (fullMatch) {
        const score = nameMatch.exact
          ? 0
          : nameMatch.all
            ? 1
            : nameMatch.some
              ? 2
              : wifeMatch.all || wifeMatch.some
                ? 3
                : 4
        addMatch(person, score)
      }

      // Also search linkedSpouse (husband attached to daughter branch). A
      // spouse's own ancestors are not available, so skip this for ancestor
      // chain searches.
      if (!segmentSearch && person.linkedSpouse) {
        const spouseWivesText = (person.linkedSpouse.wives || [])
          .map((w) => (w.type === 'tree' ? (w.personName || '') : (w.name || '')))
          .join(' ')
        const spouseRawText = `${person.linkedSpouse.name} ${person.linkedSpouse.id} ${person.linkedSpouse.branchMeta?.originalId || ''} ${person.linkedSpouse.branchMeta?.personName || ''} زوج ${person.name} ${spouseWivesText}`
        const spouseFullMatch = textMatchesAll(spouseRawText)
        const spouseNameMatch = matchScore(person.linkedSpouse.name)
        const spouseWifeMatch = matchScore(spouseWivesText)
        const spouseChainIndex = chainSearch
          ? sequenceIndex(tokenize(person.linkedSpouse.name), searchTerms)
          : -1

        if (chainSearch) {
          if (spouseChainIndex === 0) {
            addMatch(person.linkedSpouse, 0)
          } else if (spouseChainIndex > 0) {
            addMatch(person.linkedSpouse, 1)
          } else if (spouseFullMatch) {
            const score = spouseNameMatch.exact
              ? 2
              : spouseNameMatch.all
                ? 3
                : spouseNameMatch.some
                  ? 4
                  : spouseWifeMatch.all || spouseWifeMatch.some
                    ? 5
                    : 6
            addMatch(person.linkedSpouse, score)
          }
        } else if (spouseFullMatch) {
          const score = spouseNameMatch.exact
            ? 0
            : spouseNameMatch.all
              ? 1
              : spouseNameMatch.some
                ? 2
                : spouseWifeMatch.all || spouseWifeMatch.some
                  ? 3
                  : 4
          addMatch(person.linkedSpouse, score)
        }
      }

      person.children.forEach((child) => search(child, [person.name, ...ancestors]))
    }

    search(root, [])
    const results = Array.from(found.values())

    if (segmentSearch) {
      const aligned = results.filter((item) => item.score === 0)
      if (aligned.length === 0) {
        const fallback = expectedGender
          ? results.filter((item) => item.person.gender === expectedGender)
          : results
        return fallback
          .sort((a, b) => a.score - b.score || a.order - b.order)
          .map((item) => item.person)
      }
      const pool = expectedGender
        ? aligned.filter((item) => item.person.gender === expectedGender)
        : aligned
      if (pool.length === 0) return []
      const minGap = Math.min(...pool.map((item) => item.gap))
      return pool
        .filter((item) => item.gap === minGap)
        .sort((a, b) => b.exactness - a.exactness || a.order - b.order)
        .map((item) => item.person)
    }

    if (chainSearch) {
      const prefixMatches = results.filter((item) => item.score === 0)
      if (prefixMatches.length > 0) {
        return prefixMatches
          .sort((a, b) => a.order - b.order)
          .map((item) => item.person)
      }
      const chainMatches = results.filter((item) => item.score <= 1)
      if (chainMatches.length > 0) {
        return chainMatches
          .sort((a, b) => a.score - b.score || a.order - b.order)
          .map((item) => item.person)
      }
    }

    return results
      .sort((a, b) => a.score - b.score || a.order - b.order)
      .map((item) => item.person)
  }, [root, deferredSearchQuery])

  const activeMatchIndex = matches.length > 0 ? matchIndex % matches.length : 0
  const activeMatch = matches.length > 0 ? matches[activeMatchIndex] : null

  // The panel shows a small window around the active result, so Enter/Shift+Enter
  // can walk through a long result list without rendering hundreds of rows.
  const visibleSearchStart = Math.max(
    0,
    Math.min(activeMatchIndex - Math.floor(SEARCH_RESULTS_LIMIT / 2), matches.length - SEARCH_RESULTS_LIMIT),
  )
  const visibleSearchMatches = matches.slice(
    visibleSearchStart,
    visibleSearchStart + SEARCH_RESULTS_LIMIT,
  )

  // Set form of the matches used for O(1) per-card lookups while rendering.
  const matchIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches])
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

  // Unified view arrives after the initial render. Its branch paths shift the
  // main root far to the side, so recenter once the unified layout settles.
  const unifiedCenterDoneRef = useRef(false)
  useEffect(() => {
    if (!isUnifiedView) {
      unifiedCenterDoneRef.current = false
      return
    }
    if (branchPathIds.size === 0 || unifiedCenterDoneRef.current) return
    if (deferredSearchQuery.trim() || activeMatch) {
      unifiedCenterDoneRef.current = true
      return
    }
    const timer = window.setTimeout(() => {
      if (!containerRef.current || !focusRootNode) return
      const rect = containerRef.current.getBoundingClientRect()
      const isNarrow = rect.width <= 680
      setPan({
        x: rect.width / 2 - focusRootNode.x * zoom,
        y: isNarrow ? 132 : 58,
      })
      unifiedCenterDoneRef.current = true
    }, 140)
    return () => window.clearTimeout(timer)
  }, [isUnifiedView, branchPathIds, layout, focusRootNode, zoom, deferredSearchQuery, activeMatch])

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

  // On mount, put the root in the middle of the viewport. Centering the whole
  // bounds is wrong for a wide unified tree: the root can end up thousands of
  // pixels off-screen and the chart appears empty. The guard keeps later
  // expand/collapse layout changes from yanking the view back to the root.
  const centeredViewKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!containerRef.current) return
    const focusRootId = focusRootNode?.person.id ?? root.id
    const viewKey = `${focusRootId}:${isUnifiedView}`
    if (centeredViewKeyRef.current === viewKey) return
    const rect = containerRef.current.getBoundingClientRect()
    const isMobile = rect.width <= 680
    const targetX = focusRootNode?.x ?? layout.bounds.minX + layout.bounds.width / 2
    const initialZoom = isMobile
      ? Math.max(0.65, Math.min(0.85, rect.width / (layout.bounds.width + 40)))
      : 1
    centeredViewKeyRef.current = viewKey
    setPan({
      x: rect.width / 2 - targetX * initialZoom,
      y: isMobile ? 132 : 58,
    })
    setZoom(initialZoom)
  }, [focusRootNode, root.id, layout, isUnifiedView])

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.08 : 0.08
    setZoom((z) => Math.max(0.03, Math.min(2.5, z + delta)))
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
        setZoom(Math.max(0.03, Math.min(2.5, initialZoomRef.current * scale)))
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

  const toggleExpand = useCallback((personId: string, event?: React.MouseEvent) => {
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
  }, [])

  function expandAll() {
    setExpandedIds(collectAllNodeIds(root))
  }

  function collapseAll() {
    setExpandedIds(new Set([root.id]))
  }

  function fitTreeToViewport() {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const padding = rect.width <= 680 ? 36 : 72
    const fitZoom = Math.max(
      0.03,
      Math.min(
        1.25,
        (rect.width - padding * 2) / layout.bounds.width,
        (rect.height - padding * 2) / layout.bounds.height,
      ),
    )
    const centerX = layout.bounds.minX + layout.bounds.width / 2
    const centerY = layout.bounds.height / 2
    setZoom(fitZoom)
    setPan({
      x: rect.width / 2 - centerX * fitZoom,
      y: rect.height / 2 - centerY * fitZoom,
    })
  }

  const openActionModal = useCallback((person: Person) => {
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
  }, [effectiveEditMode])

  function closeActionModal() {
    setActionPerson(null)
    setDeleteConfirm(false)
  }

  function addWifeToActionPerson(wife: Wife) {
    if (!actionPerson || !onAddWife) return
    onAddWife(actionPerson.id, wife)
    setActionPerson((prev) => {
      if (!prev) return prev
      if (
        wife.type === 'tree' &&
        prev.wives.some(
          (existing) =>
            existing.type === 'tree' &&
            existing.personId === wife.personId &&
            (existing.treeId ?? '') === (wife.treeId ?? ''),
        )
      ) {
        return prev
      }
      return { ...prev, wives: [...prev.wives, wife] }
    })
  }

  function removeWifeFromActionPerson(index: number) {
    if (!actionPerson || !onRemoveWife) return
    onRemoveWife(actionPerson.id, index)
    setActionPerson((prev) =>
      prev ? { ...prev, wives: prev.wives.filter((_, i) => i !== index) } : prev,
    )
  }

  /**
   * In a unified view only nodes that belong to the current base tree may be
   * edited. Branch nodes and the virtual common root are display-only.
   */
  function canEditPerson(person: Person): boolean {
    if (person.branchMeta?.isVirtualContainer) return false
    if (isUnifiedView && person.branchMeta && person.branchMeta.type !== 'main') return false
    return true
  }

  // Stable dispatchers so the memoized cards do not all re-render just because
  // the parent page created new inline callbacks on its own re-render.
  const latestHandlersRef = useRef({ onSelectPerson, onOpenTree })
  latestHandlersRef.current = { onSelectPerson, onOpenTree }
  const handleSelectPerson = useCallback((person: Person) => {
    latestHandlersRef.current.onSelectPerson(person)
  }, [])
  const handleOpenTree = useCallback((treeId: string, personId?: string) => {
    latestHandlersRef.current.onOpenTree?.(treeId, personId)
  }, [])

  return (
    <div className="visual-tree-container" ref={containerRef}>
      {/* Top Toolbar */}
      <div className="visual-tree-toolbar">
        <div className="visual-search-box" ref={searchBoxRef}>
          <svg className="visual-search-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            inputMode="search"
            enterKeyHint="search"
            dir="rtl"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              setMatchIndex(0)
              setIsSearchOpen(true)
            }}
            onFocus={() => setIsSearchOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setSearchQuery('')
                setMatchIndex(0)
                setIsSearchOpen(false)
                e.currentTarget.blur()
                return
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (matches.length === 0) return
                e.preventDefault()
                setIsSearchOpen(true)
                setMatchIndex((i) =>
                  e.key === 'ArrowDown'
                    ? (i + 1) % matches.length
                    : (i - 1 + matches.length) % matches.length,
                )
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                if (matches.length > 0) {
                  setMatchIndex((i) =>
                    e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length
                  )
                }
              }
            }}
            placeholder="ابحث بالاسم أو المعرف…"
            role="combobox"
            aria-label="البحث في المخطط المرئي"
            aria-autocomplete="list"
            aria-controls="visual-search-results"
            aria-expanded={isSearchOpen && Boolean(searchQuery.trim())}
            title="ابحث بالاسم أو معرف الشخص أو اسم الزوجة ( / )"
          />
          {!searchQuery && (
            <kbd className="visual-search-kbd" aria-hidden="true">
              /
            </kbd>
          )}
          {searchQuery && (
            <button
              type="button"
              className="search-clear-btn"
              aria-label="مسح البحث"
              title="مسح البحث (Esc)"
              onClick={() => {
                setSearchQuery('')
                setMatchIndex(0)
                setIsSearchOpen(false)
              }}
            >
              ×
            </button>
          )}
          {matches.length > 0 && (
            <div className="search-match-count" aria-live="polite">
              <span>
                {(activeMatchIndex + 1).toLocaleString('ar')} من{' '}
                {matches.length.toLocaleString('ar')}
              </span>
              <button
                type="button"
                className="match-nav-btn"
                onClick={() =>
                  setMatchIndex((i) => (i - 1 + matches.length) % matches.length)
                }
                title="السابق (Shift+Enter)"
                aria-label="النتيجة السابقة"
              >
                ‹
              </button>
              <button
                type="button"
                className="match-nav-btn"
                onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
                title="التالي (Enter)"
                aria-label="النتيجة التالية"
              >
                ›
              </button>
            </div>
          )}

          {isSearchOpen && searchQuery.trim() && (
            <div
              className="visual-search-popover"
              id="visual-search-results"
              role="listbox"
              aria-label="نتائج البحث"
            >
              <div className="visual-search-popover-head">
                <span>نتائج البحث</span>
                <span>
                  {matches.length.toLocaleString('ar')} نتيجة
                </span>
              </div>

              {matches.length === 0 ? (
                <div className="visual-search-empty">
                  <strong>لا توجد نتائج</strong>
                  <span>جرّب الاسم أو معرف الشخص أو اسم الزوجة.</span>
                </div>
              ) : (
                <>
                  {visibleSearchMatches.map((person, offset) => {
                    const index = visibleSearchStart + offset
                    const lineage = getLineageText(root, person.id)
                    return (
                      <button
                        key={person.id}
                        type="button"
                        role="option"
                        aria-selected={index === activeMatchIndex}
                        className={`visual-search-result${
                          index === activeMatchIndex ? ' is-active' : ''
                        }`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setMatchIndex(index)
                          setIsSearchOpen(false)
                        }}
                      >
                        <span
                          className={`vsr-badge vsr-badge-${person.gender.toLowerCase()}`}
                          title={person.branchMeta?.originalId || person.id}
                        >
                          {person.branchMeta?.originalId || person.id.slice(0, 8)}
                        </span>
                        <span className="vsr-main">
                          <span className="vsr-name" dir="auto">
                            {person.name}
                          </span>
                          <span className="vsr-lineage" dir="auto">
                            {lineage || 'الجد الأعلى'}
                          </span>
                        </span>
                        <span
                          className={`vsr-gender vsr-gender-${person.gender.toLowerCase()}`}
                          aria-hidden="true"
                        >
                          {person.gender === 'M' ? '♂' : '♀'}
                        </span>
                      </button>
                    )
                  })}
                  <div className="visual-search-hint">
                    Enter: التالي · Shift+Enter: السابق · Esc: إغلاق
                  </div>
                </>
              )}
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
            onClick={() => setZoom((z) => Math.max(0.03, z - 0.15))}
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
                x: rect.width / 2 - (focusRootNode?.x ?? 0),
                y: rect.width <= 680 ? 132 : 58,
              })
              setZoom(1)
            }}
            title="توسيط الشجرة على الجذر"
          >
            توسيط
          </button>
          <button
            type="button"
            className="compact-button"
            onClick={fitTreeToViewport}
            title="ملاءمة الشجرة كاملة في الشاشة"
          >
            ملاءمة
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
          <TreeNodesLayer
            layout={layout}
            zoom={zoom}
            selectedId={selectedId}
            currentId={currentId}
            activeMatch={activeMatch}
            matchIds={matchIds}
            root={root}
            femalesRelationsMap={femalesRelationsMap}
            onSelectPerson={handleSelectPerson}
            openActionModal={openActionModal}
            toggleExpand={toggleExpand}
            onOpenTree={handleOpenTree}
            setExpandedIds={setExpandedIds}
          />
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
                      <span className="person-info-muted">الجد الأعلى للسجل</span>
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

                  {effectiveEditMode && (
                    <button
                      type="button"
                      className="modal-action-btn"
                      onClick={() => setModalTab('options')}
                    >
                      ⚙️ خيارات التعديل والإضافة
                    </button>
                  )}
                </div>
              </div>
            )}

            {modalTab === 'options' && effectiveEditMode && (
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
                  const isOtherBranch = Boolean(
                    isUnifiedView &&
                    actionPerson.branchMeta &&
                    actionPerson.branchMeta.type !== 'main' &&
                    !actionPerson.branchMeta.isVirtualContainer
                  )
                  const canEditThisPerson = canEditPerson(actionPerson)

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


                {actionPerson.id !== root.id && onDeletePerson && canEditPerson(actionPerson) && (
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

            {modalTab === 'rename' && effectiveEditMode && (
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

            {modalTab === 'children' && effectiveEditMode && (
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

            {modalTab === 'wives' && effectiveEditMode && (
              <div className="modal-form">


                <h4 className="modal-section-subtitle">الزوجات الحاليّات:</h4>
                {actionPerson.wives && actionPerson.wives.length > 0 ? (
                  <ul className="wives-manage-list">
                    {actionPerson.wives.map((wife, idx) => {
                      const linked = resolveWife(wife, root)
                      const fullLineage = wifeLineageFullLabel(wife, root, 4)
                      const isCross = Boolean(
                        wife.type === 'tree' &&
                          (wife.treeId || (linked?.branchMeta && linked.branchMeta.type !== 'main')),
                      )
                      return (
                        <li key={idx} className="wife-manage-item">
                          <span>
                            {linked ? (
                              <span className={`wife-link-tag ${isCross ? 'wife-cross-tree-tag' : ''}`}>
                                {isCross ? '🌳' : '🔗'}{' '}
                                {fullLineage || `${linked.name} (${linked.branchMeta?.originalId || linked.id})`}
                              </span>
                            ) : wife.type === 'tree' ? (
                              <span className="wife-link-tag wife-cross-tree-tag">
                                🌳 {fullLineage || wifeShortLabel(wife, root)}
                              </span>
                            ) : (
                              `⚭ ${fullLineage || wifeShortLabel(wife, root)}`
                            )}
                          </span>
                          {onRemoveWife && (
                            <button
                              type="button"
                              className="compact-button danger-text"
                              onClick={() => removeWifeFromActionPerson(idx)}
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
                                  addWifeToActionPerson(createTreeWife(item.female.id))
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
                          addWifeToActionPerson(
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
      {showTreeWifePicker && actionPerson && effectiveEditMode && (
        <TreeWifePicker
          root={root}
          linkedIds={linkedFemaleIds}
          currentTreeId={currentTreeId}
          currentTreeName={currentTreeName}
          availableTrees={availableTrees}
          onSelect={(personId, extra) => {
            if (onAddWife) {
              addWifeToActionPerson(createTreeWife(personId, extra))
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
