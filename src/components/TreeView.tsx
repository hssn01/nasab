import { useMemo, useState } from 'react'
import type { Person } from '../types'
import { resolveWife } from '../treeUtils'

interface TreeRootProps {
  person: Person
  currentId: string | null
  selectedId?: string | null
  visitedIds?: Set<string>
  onSelect: (person: Person) => void
}

interface TreeNodeProps extends TreeRootProps {
  rootPerson: Person
  query: string
  expandedIds: Set<string>
  onToggle: (id: string) => void
}


function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .toLocaleLowerCase('ar')
    .trim()
}

function matchesBranch(person: Person, query: string): boolean {
  if (!query) return true
  const ownText = searchable(`${person.name} ${person.id}`)
  return (
    ownText.includes(query) ||
    person.children.some((child) => matchesBranch(child, query))
  )
}

function collectExpandableIds(person: Person, ids = new Set<string>()) {
  if (person.children.length > 0) ids.add(person.id)
  person.children.forEach((child) => collectExpandableIds(child, ids))
  return ids
}

function TreeNode({
  person,
  currentId,
  selectedId,
  visitedIds,
  onSelect,
  rootPerson,
  query,
  expandedIds,
  onToggle,
}: TreeNodeProps) {
  if (!matchesBranch(person, query)) return null

  const hasChildren = person.children.length > 0
  const expanded = query !== '' || expandedIds.has(person.id)
  const isCurrent = person.id === currentId
  const isSelected = person.id === selectedId
  const isPending =
    visitedIds !== undefined &&
    person.gender === 'M' &&
    !visitedIds.has(person.id)

  return (
    <li className="node" role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={`node-row${isCurrent ? ' is-current' : ''}${
          isPending ? ' is-pending' : ''
        }${isSelected ? ' is-selected' : ''}`}
      >
        {hasChildren ? (
          <button
            type="button"
            className="tree-toggle"
            onClick={() => onToggle(person.id)}
            disabled={query !== ''}
            aria-label={expanded ? 'طي الفرع' : 'توسيع الفرع'}
            title={query ? 'امسح البحث للتحكم في الفروع' : undefined}
          >
            {expanded ? '⌄' : '‹'}
          </button>
        ) : (
          <span className="tree-toggle is-empty" aria-hidden="true">
            ·
          </span>
        )}
        <button
          type="button"
          className="tree-person"
          onClick={() => onSelect(person)}
        >
          <span className={`badge badge-${person.gender.toLowerCase()}`}>
            {person.id}
          </span>
          <span className="node-name" dir="auto">
            {person.name}
          </span>

          {person.wives && person.wives.length > 0 && (
            <span className="node-wives-list">
              {person.wives.map((w, idx) => {
                const linked = resolveWife(w, rootPerson)
                if (linked) {
                  return (
                    <span
                      key={idx}
                      className="wife-link-tag"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelect(linked)
                      }}
                      title={`زوجة من نساء القبيلة: ${linked.name} (${linked.id})`}
                    >
                      🔗 {linked.name} ({linked.id})
                    </span>
                  )
                }
                return <span key={idx} className="wife-text">⚭ {w}</span>
              })}
            </span>
          )}

          {hasChildren && (
            <span className="child-count">{person.children.length}</span>
          )}
        </button>
      </div>

      {hasChildren && expanded && (
        <ul className="node-children" role="group">
          {person.children.map((child) => (
            <TreeNode
              key={child.id}
              person={child}
              currentId={currentId}
              selectedId={selectedId}
              visitedIds={visitedIds}
              onSelect={onSelect}
              rootPerson={rootPerson}
              query={query}
              expandedIds={expandedIds}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function TreeRoot(props: TreeRootProps) {
  const [query, setQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set([props.person.id]),
  )
  const normalizedQuery = useMemo(() => searchable(query), [query])

  function toggle(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="tree-navigator">
      <div className="tree-search">
        <input
          type="search"
          dir="rtl"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ابحث بالاسم أو المعرّف…"
          aria-label="البحث في شجرة الأشخاص"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="مسح البحث">
            ×
          </button>
        )}
      </div>

      <div className="tree-controls">
        <button
          type="button"
          onClick={() => setExpandedIds(collectExpandableIds(props.person))}
        >
          توسيع الكل
        </button>
        <button type="button" onClick={() => setExpandedIds(new Set())}>
          طي الكل
        </button>
      </div>

      {matchesBranch(props.person, normalizedQuery) ? (
        <ul className="tree" role="tree">
          <TreeNode
            {...props}
            rootPerson={props.person}
            query={normalizedQuery}
            expandedIds={expandedIds}
            onToggle={toggle}
          />
        </ul>
      ) : (
        <p className="tree-empty">لا توجد نتيجة مطابقة.</p>
      )}
    </div>
  )
}

