import { useState, useMemo, useEffect } from 'react'
import type { Person, TreeLink, TreeMeta, Wife } from '../types'
import {
  findPath,
  motherDisplayLabel,
  resolveWife,
  wifeLineageFullLabel,
  cleanBranchOrTreeTitle,
  cleanLineageText,
  displayPersonName,
  getCachedTreeRoot,
  getAllKnownCachedRoots,
} from '../treeUtils'
import '../PrintableTribute.css'

interface PrintableTributeViewProps {
  root: Person
  treeName?: string
  linkedFrom?: TreeLink
  linkedTrees?: TreeMeta[]
  isUnified?: boolean
  branchCount?: number
  onToggleUnified?: () => void
  onGoBack: () => void
  onGoToChart?: () => void
  onOpenTree?: (treeId: string) => void
}

// A "family entry" = one parent in DFS order, with full lineage breadcrumb
interface FamilyEntry {
  person: Person
  lineage: Person[]   // ancestors from root down to this person (inclusive)
  sons: Person[]
  daughters: Person[]
  wives: Wife[]
  hasDescendants: boolean
  isDaughterBranch?: boolean
  isDaughterRoot?: boolean
  husbandName?: string
  daughterMotherName?: string
  branchPaternalAncestors?: string[]
}

interface BranchWalkContext {
  daughterNode: Person
  daughterAncestors: Person[]
  husbandName?: string
  paternalChain: string[]
}

// Collect family heads, strictly separating paternal line from daughter branches
function collectFamilyEntries(root: Person): {
  paternalEntries: FamilyEntry[]
  daughterEntries: FamilyEntry[]
} {
  const paternalEntries: FamilyEntry[] = []
  const daughterEntries: FamilyEntry[] = []

  function walk(node: Person, ancestors: Person[], ctx?: BranchWalkContext) {
    const path = [...ancestors, node]
    const sons = node.children.filter((c) => c.gender === 'M')
    const daughters = node.children.filter((c) => c.gender === 'F')
    const hasChildren = sons.length > 0 || daughters.length > 0
    const hasDescendants = sons.some((s) => s.children.length > 0 || s.wives.length > 0)

    if (!ctx) {
      // Main paternal tree
      if (node.gender === 'M') {
        if (hasChildren) {
          paternalEntries.push({
            person: node,
            lineage: path,
            sons,
            daughters,
            wives: node.wives || [],
            hasDescendants,
          })
        }
        for (const child of node.children) {
          walk(child, path, undefined)
        }
      } else {
        // Female in main tree (daughter of a male ancestor)
        // If she has children (attached daughter branch), she begins a daughter branch placed at the bottom
        if (hasChildren || node.branchMeta?.type === 'daughter-branch' || node.linkedSpouse) {
          let husband =
            node.linkedSpouse?.name ||
            (node.branchMeta?.personName && node.branchMeta.personName !== node.name
              ? node.branchMeta.personName
              : undefined)
          if (!husband && node.branchMeta?.treeName) {
            husband = cleanBranchOrTreeTitle(node.branchMeta.treeName)
          }
          if (husband) {
            husband = cleanLineageText(cleanBranchOrTreeTitle(husband))
          }

          daughterEntries.push({
            person: node,
            lineage: path,
            sons,
            daughters,
            wives: [],
            hasDescendants,
            isDaughterBranch: true,
            isDaughterRoot: true,
            husbandName: husband,
          })

          const newCtx: BranchWalkContext = {
            daughterNode: node,
            daughterAncestors: path,
            husbandName: husband,
            paternalChain: husband ? [husband] : [],
          }

          for (const child of node.children) {
            walk(child, path, newCtx)
          }
        }
      }
    } else {
      // Inside daughter branch (bottom section of PDF)
      if (hasChildren) {
        const isMale = node.gender === 'M'
        daughterEntries.push({
          person: node,
          lineage: path,
          sons,
          daughters,
          wives: isMale ? node.wives || [] : [],
          hasDescendants,
          isDaughterBranch: true,
          isDaughterRoot: false,
          husbandName: ctx.husbandName,
          daughterMotherName: ctx.daughterNode.name,
          branchPaternalAncestors: [...ctx.paternalChain],
        })
      }

      const nextCtx: BranchWalkContext = {
        ...ctx,
        paternalChain: node.gender === 'M' ? [...ctx.paternalChain, node.name] : ctx.paternalChain,
      }

      for (const child of node.children) {
        walk(child, path, nextCtx)
      }
    }
  }

  walk(root, [])
  return { paternalEntries, daughterEntries }
}


export function PrintableTributeView({
  root,
  treeName,
  isUnified,
  branchCount,
  onToggleUnified,
  onGoBack,
  onGoToChart,
}: PrintableTributeViewProps) {
  const [inspectedPerson, setInspectedPerson] = useState<Person | null>(null)

  const handleScrollToFamily = (personId: string) => {
    setInspectedPerson(null)
    setTimeout(() => {
      const el = document.getElementById(`family-entry-${personId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('highlight-pulse')
        setTimeout(() => el.classList.remove('highlight-pulse'), 2500)
      }
    }, 100)
  }

  const { paternalEntries, daughterEntries } = useMemo(() => collectFamilyEntries(root), [root])

  // Only parents who have children (sons or daughters) appear as sections
  const visiblePaternalEntries = useMemo(() => {
    return paternalEntries.filter((e) => e.sons.length > 0 || e.daughters.length > 0)
  }, [paternalEntries])

  const visibleDaughterEntries = useMemo(() => {
    return daughterEntries.filter((e) => e.sons.length > 0 || e.daughters.length > 0)
  }, [daughterEntries])

  const currentDate = 'أغسطس 2026م'

  const docTitle = useMemo(() => {
    let name = cleanBranchOrTreeTitle(treeName || '')
    if (!name || name === 'الأصل المشترك') {
      name = cleanBranchOrTreeTitle(root.name)
    }
    name = cleanBranchOrTreeTitle(name) || 'العائلة'
    if (isUnified) {
      return `السجل الموحد لعائلة آل ${name}`
    }
    return `سجل عائلة آل ${name}`
  }, [isUnified, treeName, root.name])

  useEffect(() => {
    const previousTitle = document.title
    document.title = docTitle
    return () => {
      document.title = previousTitle
    }
  }, [docTitle])

  return (
    <div className="print-page-wrapper" dir="rtl">
      {/* ── Screen-Only Minimal Toolbar (No Filters) ── */}
      <aside className="print-toolbar-container" aria-label="أدوات الطباعة">
        <div className="print-toolbar">
          <div className="print-toolbar-top-row">
            <div className="print-toolbar-nav-group">
              <button type="button" className="print-nav-btn" onClick={onGoBack}>
                ← العودة
              </button>
              {onGoToChart && (
                <button type="button" className="print-nav-btn" onClick={onGoToChart}>
                  🌳 مخطط الشجرة
                </button>
              )}
              {onToggleUnified && (
                <button
                  type="button"
                  className={`print-nav-btn${isUnified ? ' active' : ''}`}
                  onClick={onToggleUnified}
                  title="التبديل بين سجل الشجرة الأساسية وسجل الأفرع الموحدة الشامل"
                  style={isUnified ? { background: '#2563eb', color: '#ffffff', borderColor: '#3b82f6' } : undefined}
                >
                  {isUnified ? `🌐 سجل موحد شامل (${branchCount || ''} فروع) ✓` : `🌐 دمج الفروع في سجل موحد (${branchCount || ''})`}
                </button>
              )}
            </div>

            <button type="button" className="print-action-primary" onClick={() => window.print()}>
              🖨️ طباعة / حفظ PDF
            </button>
          </div>
        </div>
      </aside>

      {/* ── Printable Book-Style Document ── */}
      <main className="print-stage">
        <article className="tribute-paper book-style">
          <table className="print-table-shell">
            <thead className="print-running-thead">
              <tr>
                <th>
                  <div className="print-running-header">
                    <span>{docTitle}</span>
                    <span>الجد الأعلى: {displayPersonName(root.name)}</span>
                    <span>آخر تحديث: {currentDate}</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="print-table-body">
              <tr>
                <td>
                  {/* Book Header */}
                  <header className="book-document-header">
                    <p className="book-basmala">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</p>
                    <h1 className="book-main-title">{docTitle}</h1>
                    <p className="book-progenitor">الجد الأعلى: <strong>{displayPersonName(root.name)}</strong></p>
                    <p className="book-update-date">آخر تحديث للسجل: {currentDate}</p>
                  </header>

                  {/* Main Paternal Families Register */}
                  <section className="book-register-body">
                    {visiblePaternalEntries.map((entry) => (
                      <FamilyEntryCard
                        key={entry.person.id}
                        entry={entry}
                        root={root}
                        onSelectPerson={setInspectedPerson}
                      />
                    ))}
                  </section>

                  {/* Daughter Branches Section (placed at the bottom of the PDF) */}
                  {visibleDaughterEntries.length > 0 && (
                    <section className="book-daughters-branches-section" aria-label="أعقاب وفروع البنات">
                      <div className="book-branches-section-header">
                        <span className="book-branches-line"></span>
                        <h2 className="book-branches-title">فروع وأعقاب بنات العائلة (الأسباط)</h2>
                        <span className="book-branches-line"></span>
                      </div>
                      <div className="book-daughters-branches-list">
                        {visibleDaughterEntries.map((entry) => (
                          <DaughterBranchFamilyCard
                            key={entry.person.id}
                            entry={entry}
                            root={root}
                            onSelectPerson={setInspectedPerson}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                </td>
              </tr>
            </tbody>
          </table>
        </article>
      </main>

      {/* Person Profile Modal Popup */}
      {inspectedPerson && (
        <PersonDetailModal
          person={inspectedPerson}
          root={root}
          onClose={() => setInspectedPerson(null)}
          onSelectPerson={(p) => setInspectedPerson(p)}
          onScrollToFamily={handleScrollToFamily}
          onGoToChart={onGoToChart}
        />
      )}
    </div>
  )
}

/* =============================================================================
   Family Entry Card — Authentic book layout for paternal families
   ============================================================================= */
function FamilyEntryCard({
  entry,
  root,
  onSelectPerson,
}: {
  entry: FamilyEntry
  root: Person
  onSelectPerson: (p: Person) => void
}) {
  const { person, lineage, sons, daughters, wives } = entry
  // Lineage ancestors excluding self, reversed from immediate father up to root
  const ancestorPath = lineage.slice(0, -1)
  const hasMultipleWives = wives.length > 1

  return (
    <div className="book-entry-card" id={`family-entry-${person.id}`}>
      {/* 1. Header: أولاد [الاسم] بن [الأجداد] : */}
      <div className="book-entry-header">
        <span className="book-label-sons">أولاد</span>{' '}
        <strong
          className="book-father-name is-clickable"
          onClick={() => onSelectPerson(person)}
          title={`انقر لعرض بطاقة ${person.name}`}
        >
          {displayPersonName(person.name)}
        </strong>
        {ancestorPath.length > 0 && (
          <span className="book-lineage-ancestors">
            {' '}بن{' '}
            {[...ancestorPath].reverse().map((p, i) => (
              <span key={p.id}>
                {i > 0 && ' بن '}
                <span
                  className="book-ancestor-name is-clickable"
                  onClick={() => onSelectPerson(p)}
                  title={`انقر لعرض بطاقة ${p.name}`}
                >
                  {displayPersonName(p.name)}
                </span>
              </span>
            ))}
          </span>
        )}
        <span className="book-colon"> : </span>
        {sons.length === 0 && (
          <span className="book-no-sons-notice">بلا أولاد ذكور</span>
        )}
      </div>

      {/* 2. Sons Numbered List */}
      {sons.length > 0 && (
        <ol className="book-children-list">
          {sons.map((s, i) => {
            const mLabel = hasMultipleWives ? motherDisplayLabel(s, person, root) : null
            return (
              <li key={s.id} className="book-child-item">
                <span className="book-child-index">{(i + 1).toLocaleString('ar')}- </span>
                <span
                  className="book-child-name is-clickable"
                  onClick={() => onSelectPerson(s)}
                  title={`انقر لعرض بطاقة ${s.name}`}
                >
                  {displayPersonName(s.name)}
                </span>
                {mLabel && (
                  <span className="book-child-mother"> (أمه: {cleanLineageText(mLabel)})</span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {/* 3. Daughters Header and Numbered List */}
      {daughters.length > 0 && (
        <div className="book-daughters-section">
          <div className="book-daughters-header">
            <span className="book-label-daughters">بنات</span>{' '}
            <strong
              className="book-father-subname is-clickable"
              onClick={() => onSelectPerson(person)}
              title={`انقر لعرض بطاقة ${person.name}`}
            >
              {displayPersonName(person.name)}
            </strong>
            <span className="book-colon"> :</span>
          </div>
          <ol className="book-children-list">
            {daughters.map((d, i) => {
              const mLabel = hasMultipleWives ? motherDisplayLabel(d, person, root) : null
              return (
                <li key={d.id} className="book-child-item">
                  <span className="book-child-index">{(i + 1).toLocaleString('ar')}- </span>
                  <span
                    className="book-child-name is-clickable"
                    onClick={() => onSelectPerson(d)}
                    title={`انقر لعرض بطاقة ${d.name}`}
                  >
                    {displayPersonName(d.name)}
                  </span>
                  {mLabel && (
                    <span className="book-child-mother"> (أمها: {cleanLineageText(mLabel)})</span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {/* 4. Mother / Wives statement */}
      {wives.length > 0 && (
        <div className="book-wives-statement">
          {wives.length === 1 ? (
            <p className="book-mother-line">
              أما أم أولاد <strong>{displayPersonName(person.name)}</strong> فهي{' '}
              <span className="book-wife-full">
                {(() => {
                  const wife = wives[0]
                  const linked = resolveWife(wife, root)
                  const label = wifeLineageFullLabel(wife, root, 6)
                  return linked ? (
                    <span
                      className="is-clickable"
                      onClick={() => onSelectPerson(linked)}
                      title={`انقر لعرض بطاقة ${linked.name}`}
                    >
                      {label}
                    </span>
                  ) : (
                    label
                  )
                })()}
              </span>
              .
            </p>
          ) : (
            <p className="book-mother-line">
              أما زوجات <strong>{displayPersonName(person.name)}</strong> فهن:{' '}
              {wives.map((w, idx) => {
                const linked = resolveWife(w, root)
                const label = wifeLineageFullLabel(w, root, 6)
                return (
                  <span key={w.id}>
                    {idx > 0 && '، و'}
                    <span
                      className={linked ? 'is-clickable' : ''}
                      onClick={linked ? () => onSelectPerson(linked) : undefined}
                      title={linked ? `انقر لعرض بطاقة ${linked.name}` : label}
                    >
                      {label}
                    </span>
                  </span>
                )
              })}
              .
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* =============================================================================
   Daughter Branch Family Card — Genealogical cards placed at the bottom of the PDF
   ============================================================================= */
function DaughterBranchFamilyCard({
  entry,
  root,
  onSelectPerson,
}: {
  entry: FamilyEntry
  root: Person
  onSelectPerson: (p: Person) => void
}) {
  const {
    person,
    lineage,
    sons,
    daughters,
    wives,
    isDaughterRoot,
    husbandName,
    daughterMotherName,
    branchPaternalAncestors,
  } = entry

  // Lineage ancestors excluding self
  const ancestorPath = lineage.slice(0, -1)
  const isFemale = person.gender === 'F' || !!isDaughterRoot
  const hasMultipleWives = !isFemale && wives.length > 1
  const cleanHusband = husbandName ? cleanLineageText(cleanBranchOrTreeTitle(husbandName)) : undefined

  return (
    <div className={`book-entry-card${isFemale ? ' female-branch-card' : ''}`} id={`family-entry-${person.id}`}>
      {/* 1. Header */}
      <div className="book-entry-header">
        {isDaughterRoot ? (
          <>
            <span className="book-label-sons">عقب</span>{' '}
            <strong
              className="book-father-name is-clickable"
              onClick={() => onSelectPerson(person)}
              title={`انقر لعرض بطاقة ${person.name}`}
            >
              {displayPersonName(person.name)}
            </strong>
            {ancestorPath.length > 0 && (
              <span className="book-lineage-ancestors">
                {' '}بنت{' '}
                {[...ancestorPath].reverse().map((p, i) => (
                  <span key={p.id}>
                    {i > 0 && ' بن '}
                    <span
                      className="book-ancestor-name is-clickable"
                      onClick={() => onSelectPerson(p)}
                      title={`انقر لعرض بطاقة ${p.name}`}
                    >
                      {displayPersonName(p.name)}
                    </span>
                  </span>
                ))}
              </span>
            )}
            {cleanHusband && (
              <span className="book-female-spouse-tag"> (زوجة {cleanHusband})</span>
            )}
          </>
        ) : isFemale ? (
          <>
            <span className="book-label-sons">عقب</span>{' '}
            <strong
              className="book-father-name is-clickable"
              onClick={() => onSelectPerson(person)}
              title={`انقر لعرض بطاقة ${person.name}`}
            >
              {displayPersonName(person.name)}
            </strong>
            {branchPaternalAncestors && branchPaternalAncestors.length > 0 && (
              <span className="book-lineage-ancestors">
                {' '}بنت{' '}
                {[...branchPaternalAncestors].reverse().map(displayPersonName).join(' بن ')}
              </span>
            )}
            {cleanHusband && (
              <span className="book-female-spouse-tag"> (زوجة {cleanHusband})</span>
            )}
          </>
        ) : (
          <>
            <span className="book-label-sons">أولاد</span>{' '}
            <strong
              className="book-father-name is-clickable"
              onClick={() => onSelectPerson(person)}
              title={`انقر لعرض بطاقة ${person.name}`}
            >
              {displayPersonName(person.name)}
            </strong>
            {branchPaternalAncestors && branchPaternalAncestors.length > 0 && (
              <span className="book-lineage-ancestors">
                {' '}بن{' '}
                {[...branchPaternalAncestors].reverse().map(displayPersonName).join(' بن ')}
              </span>
            )}
            {daughterMotherName && branchPaternalAncestors && branchPaternalAncestors.length <= 1 && (
              <span className="book-branch-mother-tag"> (أمه: {displayPersonName(daughterMotherName)})</span>
            )}
          </>
        )}
        <span className="book-colon"> : </span>
        {sons.length === 0 && (
          <span className="book-no-sons-notice">بلا أولاد ذكور</span>
        )}
      </div>

      {/* 2. Sons Numbered List */}
      {sons.length > 0 && (
        <ol className="book-children-list">
          {sons.map((s, i) => {
            const mLabel = hasMultipleWives ? motherDisplayLabel(s, person, root) : null
            return (
              <li key={s.id} className="book-child-item">
                <span className="book-child-index">{(i + 1).toLocaleString('ar')}- </span>
                <span
                  className="book-child-name is-clickable"
                  onClick={() => onSelectPerson(s)}
                  title={`انقر لعرض بطاقة ${s.name}`}
                >
                  {displayPersonName(s.name)}
                </span>
                {mLabel && (
                  <span className="book-child-mother"> (أمه: {cleanLineageText(mLabel)})</span>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {/* 3. Daughters Header and Numbered List */}
      {daughters.length > 0 && (
        <div className="book-daughters-section">
          <div className="book-daughters-header">
            <span className="book-label-daughters">بنات</span>{' '}
            <strong
              className="book-father-subname is-clickable"
              onClick={() => onSelectPerson(person)}
              title={`انقر لعرض بطاقة ${person.name}`}
            >
              {displayPersonName(person.name)}
            </strong>
            <span className="book-colon"> :</span>
          </div>
          <ol className="book-children-list">
            {daughters.map((d, i) => {
              const mLabel = hasMultipleWives ? motherDisplayLabel(d, person, root) : null
              return (
                <li key={d.id} className="book-child-item">
                  <span className="book-child-index">{(i + 1).toLocaleString('ar')}- </span>
                  <span
                    className="book-child-name is-clickable"
                    onClick={() => onSelectPerson(d)}
                    title={`انقر لعرض بطاقة ${d.name}`}
                  >
                    {displayPersonName(d.name)}
                  </span>
                  {mLabel && (
                    <span className="book-child-mother"> (أمها: {cleanLineageText(mLabel)})</span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {/* 4. Mother / Wives statement */}
      {isFemale ? (
        cleanHusband && (
          <div className="book-wives-statement">
            <p className="book-mother-line">
              أما والدهم فهو <strong>{cleanHusband}</strong>.
            </p>
          </div>
        )
      ) : (
        wives.length > 0 && (
          <div className="book-wives-statement">
            {wives.length === 1 ? (
              <p className="book-mother-line">
                أما أم أولاد <strong>{displayPersonName(person.name)}</strong> فهي{' '}
                <span className="book-wife-full">
                  {(() => {
                    const wife = wives[0]
                    const linked = resolveWife(wife, root)
                    const label = wifeLineageFullLabel(wife, root, 6)
                    return linked ? (
                      <span
                        className="is-clickable"
                        onClick={() => onSelectPerson(linked)}
                        title={`انقر لعرض بطاقة ${linked.name}`}
                      >
                        {label}
                      </span>
                    ) : (
                      label
                    )
                  })()}
                </span>
                .
              </p>
            ) : (
              <p className="book-mother-line">
                أما زوجات <strong>{displayPersonName(person.name)}</strong> فهن:{' '}
                {wives.map((w, idx) => {
                  const linked = resolveWife(w, root)
                  const label = wifeLineageFullLabel(w, root, 6)
                  return (
                    <span key={w.id}>
                      {idx > 0 && '، و'}
                      <span
                        className={linked ? 'is-clickable' : ''}
                        onClick={linked ? () => onSelectPerson(linked) : undefined}
                        title={linked ? `انقر لعرض بطاقة ${linked.name}` : label}
                      >
                        {label}
                      </span>
                    </span>
                  )
                })}
                .
              </p>
            )}
          </div>
        )
      )}
    </div>
  )
}

/* =============================================================================
   Person Detail Modal — Interactive card popup in view mode
   ============================================================================= */
function PersonDetailModal({
  person,
  root,
  onClose,
  onSelectPerson,
  onScrollToFamily,
  onGoToChart,
}: {
  person: Person
  root: Person
  onClose: () => void
  onSelectPerson: (p: Person) => void
  onScrollToFamily: (personId: string) => void
  onGoToChart?: () => void
}) {
  const isMale = person.gender === 'M'
  let path = findPath(root, person.id)
  if (path.length <= 1) {
    const targetTreeId = person.branchMeta?.treeId
    if (targetTreeId) {
      const sourceRoot = getCachedTreeRoot(targetTreeId)
      if (sourceRoot) {
        const p = findPath(sourceRoot, person.branchMeta?.originalId || person.id)
        if (p.length > 1) path = p
      }
    }
    if (path.length <= 1) {
      for (const otherRoot of getAllKnownCachedRoots()) {
        const p = findPath(otherRoot, person.branchMeta?.originalId || person.id)
        if (p.length > 1) {
          path = p
          break
        }
      }
    }
  }
  const ancestors = path.slice(0, -1).reverse() // from father upwards
  const parent = ancestors.length > 0 ? ancestors[0] : null
  const sons = person.children.filter((c) => c.gender === 'M')
  const daughters = person.children.filter((c) => c.gender === 'F')
  const generation = path.length

  // Build patronymic breadcrumb
  const lineageBreadcrumb = (() => {
    if (path.length === 0) return displayPersonName(person.name)
    const rev = [...path].reverse()
    return rev
      .map((p, idx) => {
        const name = displayPersonName(p.name)
        if (idx === 0) return name
        const prev = rev[idx - 1]
        const connector = prev.gender === 'F' ? 'بنت' : 'بن'
        return `${connector} ${name}`
      })
      .join(' ')
  })()

  const motherName = useMemo(() => {
    return cleanLineageText(motherDisplayLabel(person, parent, root))
  }, [person, parent, root])

  return (
    <div
      className="tribute-person-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="tribute-person-modal"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        {/* Modal Header */}
        <div className="tribute-modal-header">
          <div className="tribute-modal-title-group">
            <div className="tribute-modal-badges">
              <span className={`tribute-badge-gender ${isMale ? 'male' : 'female'}`}>
                {isMale ? '♂ رجل' : '♀ امرأة'}
              </span>
              <span className="tribute-badge-gen">جيل {generation.toLocaleString('ar')}</span>
              <span className="tribute-badge-id">{person.id}</span>
            </div>
            <h2 className="tribute-modal-name">{displayPersonName(person.name)}</h2>
          </div>
          <button
            type="button"
            className="tribute-modal-close"
            onClick={onClose}
            aria-label="إغلاق"
          >
            ✕
          </button>
        </div>

        {/* Full Lineage */}
        <div className="tribute-modal-section tribute-modal-lineage">
          <span className="tribute-modal-sec-title">سلسلة النسب الكاملة:</span>
          <p className="tribute-lineage-text">{lineageBreadcrumb}</p>
        </div>

        {/* Parents info */}
        <div className="tribute-modal-section tribute-modal-parents">
          {parent && (
            <div className="tribute-info-row">
              <span className="tribute-info-label">الأب:</span>
              <button
                type="button"
                className="tribute-person-link-btn"
                onClick={() => onSelectPerson(parent)}
              >
                {displayPersonName(parent.name)} <span className="tribute-link-id">({parent.id})</span> ↗
              </button>
            </div>
          )}
          {motherName && (
            <div className="tribute-info-row">
              <span className="tribute-info-label">الأم:</span>
              <span className="tribute-info-val">🌸 {motherName}</span>
            </div>
          )}
        </div>

        {/* Wives (for Males) */}
        {isMale && person.wives && person.wives.length > 0 && (
          <div className="tribute-modal-section">
            <span className="tribute-modal-sec-title">
              الزوجات ({person.wives.length.toLocaleString('ar')}):
            </span>
            <div className="tribute-modal-chips-list">
              {person.wives.map((wife) => {
                const fullLabel = wifeLineageFullLabel(wife, root, 4)
                const linked = resolveWife(wife, root)
                return (
                  <div key={wife.id} className="tribute-modal-wife-card">
                    <span className="tribute-wife-icon">⚭</span>
                    <span className="tribute-wife-name">{fullLabel}</span>
                    {linked && (
                      <button
                        type="button"
                        className="tribute-inline-link"
                        onClick={() => onSelectPerson(linked)}
                      >
                        عرض بطاقتها ↗
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Children (if has children) */}
        {(sons.length > 0 || daughters.length > 0) && (
          <div className="tribute-modal-section">
            <span className="tribute-modal-sec-title">
              الأولاد ({person.children.length.toLocaleString('ar')}):
            </span>
            {sons.length > 0 && (
              <div className="tribute-children-group">
                <span className="tribute-children-label">
                  الأبناء ({sons.length.toLocaleString('ar')}):
                </span>
                <div className="tribute-children-chips">
                  {sons.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="tribute-child-btn male"
                      onClick={() => onSelectPerson(s)}
                    >
                      {s.name} <span className="child-btn-id">({s.id})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {daughters.length > 0 && (
              <div className="tribute-children-group">
                <span className="tribute-children-label">
                  البنات ({daughters.length.toLocaleString('ar')}):
                </span>
                <div className="tribute-children-chips">
                  {daughters.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="tribute-child-btn female"
                      onClick={() => onSelectPerson(d)}
                    >
                      {d.name} <span className="child-btn-id">({d.id})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Modal Actions */}
        <div className="tribute-modal-actions">
          {isMale && (
            <button
              type="button"
              className="tribute-modal-action-btn primary"
              onClick={() => onScrollToFamily(person.id)}
            >
              📖 انتقال إلى سجل العائلة في الوثيقة
            </button>
          )}
          {onGoToChart && (
            <button
              type="button"
              className="tribute-modal-action-btn secondary"
              onClick={() => {
                onClose()
                onGoToChart()
              }}
            >
              🌳 الانتقال إلى المخطط الشجري
            </button>
          )}
          <button
            type="button"
            className="tribute-modal-action-btn ghost"
            onClick={onClose}
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  )
}
