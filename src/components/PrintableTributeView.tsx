import { useState, useMemo } from 'react'
import type { Person, TreeLink, TreeMeta, Wife } from '../types'
import {
  countPeople,
  findPath,
  findPerson,
  motherDisplayLabel,
  resolveWife,
  wifeLineageFullLabel,
} from '../treeUtils'
import '../PrintableTribute.css'

interface PrintableTributeViewProps {
  root: Person
  treeName?: string
  linkedFrom?: TreeLink
  linkedTrees?: TreeMeta[]
  onGoBack: () => void
  onGoToChart?: () => void
  onOpenTree?: (treeId: string) => void
}

// A "family entry" = one male in DFS order, with full lineage breadcrumb
interface FamilyEntry {
  person: Person
  lineage: Person[]   // ancestors from root down to this person (inclusive)
  sons: Person[]
  daughters: Person[]
  wives: Wife[]
  hasDescendants: boolean
}

// Collect all males in DFS pre-order, preserving full lineage path
function collectFamilyEntries(root: Person, initialAncestors: Person[] = []): FamilyEntry[] {
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

  walk(root, initialAncestors)
  return entries
}

// Build a compact text outline of the whole tree
interface OutlineNode {
  person: Person
  depth: number
  children: OutlineNode[]
}

function buildOutline(node: Person, depth: number): OutlineNode {
  return {
    person: node,
    depth,
    children: node.children.map((c) => buildOutline(c, depth + 1)),
  }
}

export function PrintableTributeView({
  root,
  linkedFrom,
  linkedTrees,
  onGoBack,
  onGoToChart,
  onOpenTree,
}: PrintableTributeViewProps) {
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [activeTab, setActiveTab] = useState<'register' | 'outline'>('register')
  const [density, setDensity] = useState<'normal' | 'compact' | 'spacious'>('normal')
  const [selectedBranchId, setSelectedBranchId] = useState<string | 'all'>('all')
  const [separateCover, setSeparateCover] = useState(true)
  const [showBranchDividers, setShowBranchDividers] = useState(true)
  const [showIds, setShowIds] = useState(true)
  const [showWives, setShowWives] = useState(true)
  const [showDedication, setShowDedication] = useState(true)
  const [showLeafEntries, setShowLeafEntries] = useState(true)
  const [inspectedPerson, setInspectedPerson] = useState<Person | null>(null)

  const handleScrollToFamily = (personId: string) => {
    setInspectedPerson(null)
    setActiveTab('register')
    setTimeout(() => {
      const el = document.getElementById(`family-entry-${personId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('highlight-pulse')
        setTimeout(() => el.classList.remove('highlight-pulse'), 2500)
      }
    }, 100)
  }

  // Direct male branches of root
  const majorBranches = useMemo(() => {
    return root.children.filter((c) => c.gender === 'M')
  }, [root])

  const activeBranch = useMemo(() => {
    if (selectedBranchId === 'all') return null
    return majorBranches.find((b) => b.id === selectedBranchId) || null
  }, [selectedBranchId, majorBranches])

  const activeRoot = activeBranch || root

  const counts = useMemo(() => countPeople(activeRoot), [activeRoot])
  const familyEntries = useMemo(() => {
    if (activeBranch) {
      return collectFamilyEntries(activeBranch, [root])
    }
    return collectFamilyEntries(root, [])
  }, [activeBranch, root])

  const outlineRoot = useMemo(() => buildOutline(activeRoot, 0), [activeRoot])
  const maxDepth = useMemo(() => {
    let max = 0
    function walk(e: FamilyEntry) { if (e.lineage.length > max) max = e.lineage.length }
    familyEntries.forEach(walk)
    return max
  }, [familyEntries])

  const visibleEntries = useMemo(() =>
    showLeafEntries
      ? familyEntries
      : familyEntries.filter((e) => e.sons.length > 0 || e.daughters.length > 0),
    [familyEntries, showLeafEntries]
  )

  const currentDate = useMemo(() => {
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date())
  }, [])

  const docTitle = activeBranch
    ? `مشجّر نسب آل ${activeBranch.name} بن ${root.name}`
    : `مشجّر نسب آل ${root.name}`

  return (
    <div className="print-page-wrapper" dir="rtl">
      {/* ── Screen-Only Toolbar ── */}
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
              <div className="print-view-selector" role="tablist">
                <button
                  type="button"
                  className={`print-view-tab${activeTab === 'register' ? ' active' : ''}`}
                  onClick={() => setActiveTab('register')}
                  title="سجل عائلي مرتّب حسب الفروع — كل أب وأبناؤه في مكان واحد"
                >
                  📜 السجل العائلي
                </button>
                <button
                  type="button"
                  className={`print-view-tab${activeTab === 'outline' ? ' active' : ''}`}
                  onClick={() => setActiveTab('outline')}
                  title="مشجر نصي هرمي مضغوط"
                >
                  🌿 المشجر النصي
                </button>
              </div>
            </div>

            <button type="button" className="print-action-primary" onClick={() => window.print()}>
              🖨️ طباعة / حفظ PDF
            </button>
          </div>

          <div className="print-toolbar-options-row">
            {/* Branch selector if root has multiple sons */}
            {majorBranches.length > 1 && (
              <label className="print-select-label" title="تصفية الطباعة لفرع محدد">
                <span>الفرع:</span>
                <select
                  value={selectedBranchId}
                  onChange={(e) => setSelectedBranchId(e.target.value)}
                  className="print-toolbar-select"
                >
                  <option value="all">🌳 كافة الفروع ({majorBranches.length})</option>
                  {majorBranches.map((b) => (
                    <option key={b.id} value={b.id}>
                      فرع {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Print density */}
            <label className="print-select-label" title="التحكم في كثافة الطباعة لتقليل عدد الصفحات">
              <span>الكثافة:</span>
              <select
                value={density}
                onChange={(e) => setDensity(e.target.value as any)}
                className="print-toolbar-select"
              >
                <option value="normal">عادي (مريح)</option>
                <option value="compact">مضغوط (توفير ورق)</option>
                <option value="spacious">كبير (موسّع)</option>
              </select>
            </label>

            <label className="print-toggle-label">
              <input
                type="checkbox"
                checked={orientation === 'landscape'}
                onChange={(e) => setOrientation(e.target.checked ? 'landscape' : 'portrait')}
              />
              أفقي (Landscape)
            </label>
            <label className="print-toggle-label" title="فصل الغلاف والإحصاءات في الصفحة الأولى للطباعة">
              <input
                type="checkbox"
                checked={separateCover}
                onChange={(e) => setSeparateCover(e.target.checked)}
              />
              غلاف مستقل (صفحة ١)
            </label>
            {activeTab === 'register' && selectedBranchId === 'all' && (
              <label className="print-toggle-label" title="إظهار لافتات فواصل الفروع الرئيسية">
                <input
                  type="checkbox"
                  checked={showBranchDividers}
                  onChange={(e) => setShowBranchDividers(e.target.checked)}
                />
                فواصل الفروع
              </label>
            )}
            <label className="print-toggle-label">
              <input type="checkbox" checked={showIds} onChange={(e) => setShowIds(e.target.checked)} />
              المعرفات
            </label>
            <label className="print-toggle-label">
              <input type="checkbox" checked={showWives} onChange={(e) => setShowWives(e.target.checked)} />
              الزوجات
            </label>
            <label className="print-toggle-label">
              <input type="checkbox" checked={showDedication} onChange={(e) => setShowDedication(e.target.checked)} />
              المقدمة
            </label>
            {activeTab === 'register' && (
              <label className="print-toggle-label">
                <input type="checkbox" checked={showLeafEntries} onChange={(e) => setShowLeafEntries(e.target.checked)} />
                أصحاب العقب فقط
              </label>
            )}
          </div>
        </div>
      </aside>

      {/* ── Printable Document ── */}
      <main className="print-stage">
        <article className={`tribute-paper ${orientation} density-${density}`}>
          <div className="tribute-outer-border">
            <span className="corner-ornament corner-top-right" aria-hidden="true">❖</span>
            <span className="corner-ornament corner-top-left" aria-hidden="true">❖</span>
            <span className="corner-ornament corner-bottom-right" aria-hidden="true">❖</span>
            <span className="corner-ornament corner-bottom-left" aria-hidden="true">❖</span>

            <div className="tribute-inner-border">
              {/* ── Dedicated Cover Page (Page 1 in Print) ── */}
              {separateCover && (
                <>
                  <section className="tribute-cover-page">
                    <div className="tribute-cover-frame">
                      <span className="corner-ornament corner-top-right" aria-hidden="true">❖</span>
                      <span className="corner-ornament corner-top-left" aria-hidden="true">❖</span>
                      <span className="corner-ornament corner-bottom-right" aria-hidden="true">❖</span>
                      <span className="corner-ornament corner-bottom-left" aria-hidden="true">❖</span>

                      <div className="tribute-cover-inner">
                        <header className="tribute-header">
                          <p className="tribute-basmala">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</p>
                          <div className="tribute-title-badge">وثيقة ومشجّر نسب رسمي معتمد</div>
                          <h1 className="tribute-main-title">{docTitle}</h1>
                          <p className="tribute-progenitor">
                            {activeBranch ? (
                              <>
                                رأس الفرع: <strong>{activeBranch.name}</strong> بن <strong>{root.name}</strong>
                              </>
                            ) : (
                              <>
                                الجد الأعلى: <strong>{root.name}</strong>
                              </>
                            )}
                            {showIds && (
                              <span className="family-person-id">{activeRoot.id}</span>
                            )}
                          </p>
                          <div className="tribute-divider" aria-hidden="true">
                            <span>✦ ✦ ✦</span>
                          </div>
                          <p className="tribute-lineage-text">
                            «تعلّموا من أنسابكم ما تصلون به أرحامكم» — حُررت هذه الوثيقة حفظاً للصلات ورعايةً للأواصر
                          </p>
                        </header>

                        {/* Linked Tree Context Banner (if branch) */}
                        {linkedFrom && (
                          <section className="tribute-linked-banner" aria-label="بيانات فرع النسب">
                            <span className="tribute-linked-badge-icon">
                              {linkedFrom.type === 'daughter-branch'
                                ? '🧬'
                                : linkedFrom.type === 'brother-branch'
                                ? '🤝'
                                : '🌿'}
                            </span>
                            <div className="tribute-linked-banner-content">
                              <strong className="tribute-linked-title">
                                {linkedFrom.type === 'daughter-branch'
                                  ? `فرع بنت العائلة: ${linkedFrom.personName || 'إحدى البنات'}`
                                  : linkedFrom.type === 'brother-branch'
                                  ? `فرع أخ الجد الأكبر: ${linkedFrom.personName || 'أخ الجد'}`
                                  : 'فرع عائلي مرتبط'}
                              </strong>
                              <span className="tribute-linked-sub">
                                تتفرع وتتصل هذه الشجرة بالشجرة الرئيسية «{linkedFrom.mainTreeName}»
                              </span>
                              {linkedFrom.note && (
                                <p className="tribute-linked-note">{linkedFrom.note}</p>
                              )}
                            </div>
                          </section>
                        )}

                        {/* Dedication */}
                        {showDedication && (
                          <section className="tribute-dedication">
                            الحمد لله الذي جعل الناس شعوباً وقبائل ليتعارفوا. هذه وثيقة سلالة{' '}
                            <strong>{activeBranch ? activeBranch.name : root.name}</strong> وما
                            تناسل منها عبر <strong>{maxDepth.toLocaleString('ar')} أجيال</strong>، صيانةً للحقوق ووصلاً لذوي القربى.
                          </section>
                        )}

                        {/* Stats */}
                        <section className="tribute-stats-bar" aria-label="إحصاءات النسب">
                          <div>
                            <p className="stat-item-label">الرجال</p>
                            <p className="stat-item-val">{counts.males.toLocaleString('ar')}</p>
                          </div>
                          <div>
                            <p className="stat-item-label">النساء</p>
                            <p className="stat-item-val">{counts.females.toLocaleString('ar')}</p>
                          </div>
                          <div>
                            <p className="stat-item-label">المجموع</p>
                            <p className="stat-item-val">
                              {(counts.males + counts.females).toLocaleString('ar')}
                            </p>
                          </div>
                          <div>
                            <p className="stat-item-label">عمق الأجيال</p>
                            <p className="stat-item-val">{maxDepth.toLocaleString('ar')}</p>
                          </div>
                          <div>
                            <p className="stat-item-label">تاريخ التوثيق</p>
                            <p className="stat-item-val" style={{ fontSize: '13px' }}>
                              {currentDate}
                            </p>
                          </div>
                        </section>

                        <div className="tribute-cover-seal-row">
                          <span className="tribute-seal-stamp">⚜️ وثيقة نسب رسمية معتمدة</span>
                          <span className="tribute-seal-text">
                            طُبعت آلياً من نظام «نَسَب» لحفظ وتوثيق الأنساب
                          </span>
                        </div>
                      </div>
                    </div>
                  </section>
                  <div className="cover-page-screen-break">
                    <span>📄 بداية السجل العائلي (الصفحة الثانية في الطباعة)</span>
                  </div>
                </>
              )}

              {/* ── Multi-Page Running Table Shell ── */}
              <table className="print-table-shell">
                <thead className="print-running-thead">
                  <tr>
                    <th>
                      <div className="print-running-header">
                        <span>{docTitle}</span>
                        <span>وثيقة حفظ الأنساب ورعاية الأرحام</span>
                        <span>{currentDate}</span>
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody className="print-table-body">
                  <tr>
                    <td>
                      {/* Inline Header (when separateCover is false) */}
                      {!separateCover && (
                        <>
                          <header className="tribute-header">
                            <p className="tribute-basmala">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</p>
                            <div className="tribute-title-badge">وثيقة ومشجّر نسب رسمي</div>
                            <h1 className="tribute-main-title">{docTitle}</h1>
                            <p className="tribute-progenitor">
                              الجد الأعلى: <strong>{activeBranch ? activeBranch.name : root.name}</strong>
                              {showIds && <span className="family-person-id">{activeRoot.id}</span>}
                            </p>
                            <div className="tribute-divider" aria-hidden="true"><span>✦ ✦ ✦</span></div>
                            <p className="tribute-lineage-text">
                              «تعلّموا من أنسابكم ما تصلون به أرحامكم» — حُررت هذه الوثيقة حفظاً للصلات ورعايةً للأواصر
                            </p>
                          </header>

                          {linkedFrom && (
                            <section className="tribute-linked-banner" aria-label="بيانات فرع النسب">
                              <span className="tribute-linked-badge-icon">
                                {linkedFrom.type === 'daughter-branch'
                                  ? '🧬'
                                  : linkedFrom.type === 'brother-branch'
                                  ? '🤝'
                                  : '🌿'}
                              </span>
                              <div className="tribute-linked-banner-content">
                                <strong className="tribute-linked-title">
                                  {linkedFrom.type === 'daughter-branch'
                                    ? `فرع بنت العائلة: ${linkedFrom.personName || 'إحدى البنات'}`
                                    : linkedFrom.type === 'brother-branch'
                                    ? `فرع أخ الجد الأكبر: ${linkedFrom.personName || 'أخ الجد'}`
                                    : 'فرع عائلي مرتبط'}
                                </strong>
                                <span className="tribute-linked-sub">
                                  تتفرع وتتصل هذه الشجرة بالشجرة الرئيسية «{linkedFrom.mainTreeName}»
                                </span>
                                {linkedFrom.note && (
                                  <p className="tribute-linked-note">{linkedFrom.note}</p>
                                )}
                              </div>
                            </section>
                          )}

                          {showDedication && (
                            <section className="tribute-dedication">
                              الحمد لله الذي جعل الناس شعوباً وقبائل ليتعارفوا. هذه وثيقة سلالة <strong>{activeBranch ? activeBranch.name : root.name}</strong> وما
                              تناسل منها عبر <strong>{maxDepth.toLocaleString('ar')} أجيال</strong>، صيانةً للحقوق ووصلاً لذوي القربى.
                            </section>
                          )}

                          <section className="tribute-stats-bar" aria-label="إحصاءات النسب">
                            <div>
                              <p className="stat-item-label">الرجال</p>
                              <p className="stat-item-val">{counts.males.toLocaleString('ar')}</p>
                            </div>
                            <div>
                              <p className="stat-item-label">النساء</p>
                              <p className="stat-item-val">{counts.females.toLocaleString('ar')}</p>
                            </div>
                            <div>
                              <p className="stat-item-label">المجموع</p>
                              <p className="stat-item-val">{(counts.males + counts.females).toLocaleString('ar')}</p>
                            </div>
                            <div>
                              <p className="stat-item-label">عمق الأجيال</p>
                              <p className="stat-item-val">{maxDepth.toLocaleString('ar')}</p>
                            </div>
                            <div>
                              <p className="stat-item-label">تاريخ التوثيق</p>
                              <p className="stat-item-val" style={{ fontSize: '13px' }}>{currentDate}</p>
                            </div>
                          </section>
                        </>
                      )}

                      {/* Main Content */}
                      {activeTab === 'register' ? (
                        <FamilyRegister
                          entries={visibleEntries}
                          showIds={showIds}
                          showWives={showWives}
                          showBranchDividers={showBranchDividers}
                          selectedBranchId={selectedBranchId}
                          root={root}
                          onSelectPerson={setInspectedPerson}
                        />
                      ) : (
                        <OutlineTree
                          node={outlineRoot}
                          showIds={showIds}
                          showWives={showWives}
                          root={root}
                          onSelectPerson={setInspectedPerson}
                        />
                      )}

                      {/* Linked Branches Section */}
                      {linkedTrees && linkedTrees.length > 0 && (
                        <section className="tribute-linked-trees-section" aria-label="الأفرع المرتبطة">
                          <div className="tribute-divider" aria-hidden="true"><span>✦ ✦ ✦</span></div>
                          <h2 className="tribute-section-heading">الأفرع والشجرات العائلية المرتبطة</h2>
                          <p className="tribute-section-sub">
                            شجرات وأفرع متصلة بهذا المشجر من جهة البنات أو الإخوة
                          </p>
                          <div className="tribute-linked-trees-grid">
                            {linkedTrees.map((lt) => {
                              const l = lt.linkedFrom
                              return (
                                <div key={lt.id} className="tribute-linked-card">
                                  <div className="tribute-linked-card-header">
                                    <span className="tribute-linked-pill">
                                      {l?.type === 'daughter-branch'
                                        ? '🧬 فرع بنت'
                                        : l?.type === 'brother-branch'
                                        ? '🤝 فرع أخ'
                                        : '🌿 فرع مرتبط'}
                                    </span>
                                    <strong className="tribute-linked-name">{lt.name}</strong>
                                  </div>
                                  {l?.personName && (
                                    <p className="tribute-linked-detail">
                                      الصلة: <strong>{l.personName}</strong> {l.personId ? `(${l.personId})` : ''}
                                    </p>
                                  )}
                                  {l?.note && <p className="tribute-linked-note">{l.note}</p>}
                                  {onOpenTree && (
                                    <button
                                      type="button"
                                      className="compact-button tribute-open-tree-btn"
                                      onClick={() => onOpenTree(lt.id)}
                                    >
                                      عرض وثيقة هذا الفرع ←
                                    </button>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </section>
                      )}

                      {/* Footer Certification */}
                      <footer className="tribute-footer">
                        <div className="tribute-cert-grid">
                          <div className="cert-box">
                            <p className="cert-title">✍️ إقرار وتوثيق النسب</p>
                            <div className="cert-field-row">
                              <span>اسم المحرر:</span>
                              <span>..........................................</span>
                            </div>
                            <div className="cert-field-row">
                              <span>التاريخ:</span>
                              <span>{currentDate}</span>
                            </div>
                            <div className="cert-signature-space"></div>
                            <p style={{ fontSize: '11px', color: '#8c7b64', textAlign: 'center', marginTop: '4px' }}>التوقيع والختم</p>
                          </div>
                          <div className="cert-box">
                            <p className="cert-title">📜 مراجعة وتصديق الأسرة</p>
                            <div className="cert-field-row">
                              <span>اسم المصادق:</span>
                              <span>..........................................</span>
                            </div>
                            <div className="cert-field-row">
                              <span>الصفة:</span>
                              <span>عميد الأسرة / ممثل الفخذ</span>
                            </div>
                            <div className="cert-signature-space"></div>
                            <p style={{ fontSize: '11px', color: '#8c7b64', textAlign: 'center', marginTop: '4px' }}>التوقيع والمصادقة</p>
                          </div>
                        </div>
                        <p className="tribute-closing-note">
                          طُبعت هذه الوثيقة آلياً من نظام «نَسَب» لحفظ وتوثيق الأنساب
                        </p>
                      </footer>
                    </td>
                  </tr>
                </tbody>
                <tfoot className="print-running-tfoot">
                  <tr>
                    <td>
                      <div className="print-running-footer">
                        <span>نظام «نَسَب» للتوثيق العائلي</span>
                        <span>«تعلّموا من أنسابكم ما تصلون به أرحامكم»</span>
                        <span>وثيقة رسمية معتمدة</span>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
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
   Family Register — DFS branch order, father + children together
   ============================================================================= */
function FamilyRegister({
  entries,
  showIds,
  showWives,
  showBranchDividers,
  selectedBranchId,
  root,
  onSelectPerson,
}: {
  entries: FamilyEntry[]
  showIds: boolean
  showWives: boolean
  showBranchDividers: boolean
  selectedBranchId: string
  root: Person
  onSelectPerson: (p: Person) => void
}) {
  let lastBranchId: string | null = null

  return (
    <section className="tribute-register-body">
      <p className="register-intro-note">
        مرتَّب حسب الفروع والأعقاب — انقر على أي شخص لعرض بطاقة تفاصيله ونسبه الكامل
      </p>
      {entries.map((entry) => {
        // Detect major branch switch (when entry has lineage[1])
        const branchPerson = entry.lineage.length > 1 ? entry.lineage[1] : null
        let renderBranchDivider = false

        if (
          showBranchDividers &&
          selectedBranchId === 'all' &&
          branchPerson &&
          branchPerson.id !== lastBranchId
        ) {
          lastBranchId = branchPerson.id
          renderBranchDivider = true
        }

        return (
          <div
            key={entry.person.id}
            id={`family-entry-${entry.person.id}`}
            className="family-entry-wrapper"
          >
            {renderBranchDivider && branchPerson && (
              <div className="tribute-branch-divider">
                <span className="branch-divider-icon">🌿</span>
                <div className="branch-divider-text">
                  <h3 className="branch-divider-title">
                    فرع: {branchPerson.name} بن {root.name}
                  </h3>
                  <span className="branch-divider-desc">تفصيل ذريته وأعقابه المسجّلة</span>
                </div>
              </div>
            )}
            <FamilyEntryCard
              entry={entry}
              showIds={showIds}
              showWives={showWives}
              root={root}
              onSelectPerson={onSelectPerson}
            />
          </div>
        )
      })}
    </section>
  )
}

function FamilyEntryCard({
  entry,
  showIds,
  showWives,
  root,
  onSelectPerson,
}: {
  entry: FamilyEntry
  showIds: boolean
  showWives: boolean
  root: Person
  onSelectPerson: (p: Person) => void
}) {
  const { person, lineage, sons, daughters, wives } = entry
  // Lineage breadcrumb: ancestors only (not self), reversed for Arabic "بن" format
  const ancestorPath = lineage.slice(0, -1) // all except self
  const generation = lineage.length

  return (
    <div
      className="family-entry-card"
      style={{ '--entry-depth': Math.min(generation - 1, 6) } as React.CSSProperties}
    >
      {/* Lineage breadcrumb */}
      {ancestorPath.length > 0 && (
        <p className="entry-lineage-breadcrumb">
          {[...ancestorPath].reverse().map((p, i) => (
            <span key={p.id}>
              {i > 0 && <span className="lineage-sep"> بن </span>}
              <span
                className="lineage-ancestor is-clickable"
                onClick={() => onSelectPerson(p)}
                title={`انقر لعرض بطاقة ${p.name}`}
              >
                {p.name}
              </span>
              {showIds && <span className="entry-id-tag">{p.id}</span>}
            </span>
          ))}
        </p>
      )}

      {/* Father header */}
      <div
        className="entry-father-header is-clickable"
        onClick={() => onSelectPerson(person)}
        title={`انقر لعرض بطاقة ${person.name}`}
      >
        <span className="entry-generation-badge">جيل {generation.toLocaleString('ar')}</span>
        <span className="entry-father-name">{person.name}</span>
        {showIds && <span className="family-person-id">{person.id}</span>}
        {sons.length > 0 && (
          <span className="entry-has-descendants" title="له ذرية مسجّلة">▾ له أعقاب</span>
        )}
      </div>

      {/* Wives row */}
      {showWives && wives.length > 0 && (
        <div className="entry-wives-row">
          <span className="entry-wives-label">الزوجات ({wives.length.toLocaleString('ar')}):</span>
          {wives.map((wife) => {
            const fullLineage = wifeLineageFullLabel(wife, root, 4)
            const linked =
              resolveWife(wife, root) ||
              (wife.type === 'tree' && wife.personId ? findPerson(root, wife.personId) : null)
            return (
              <span
                key={wife.id}
                className={`entry-wife-chip ${linked ? 'is-clickable' : ''}`}
                onClick={linked ? () => onSelectPerson(linked) : undefined}
                title={linked ? `انقر لعرض بطاقة ${linked.name}` : fullLineage}
              >
                ⚭ {fullLineage}
                {showIds && wife.type === 'tree' && wife.personId && (
                  <span className="entry-id-tag">{wife.personId}</span>
                )}
              </span>
            )
          })}
        </div>
      )}

      {/* Children */}
      {sons.length === 0 && daughters.length === 0 ? (
        <p className="entry-no-children">— لا عقب مسجّل في هذا الفرع</p>
      ) : (
        <div className="entry-children-row">
          {/* Sons inline with ordinal numbers */}
          {sons.length > 0 && (
            <div className="entry-children-col sons-col">
              <span className="col-label">الأبناء ({sons.length.toLocaleString('ar')}):</span>
              <span className="children-inline-list">
                {sons.map((s, i) => {
                  const mLabel = motherDisplayLabel(s, person, root)
                  return (
                    <span
                      key={s.id}
                      className="child-chip male-chip is-clickable"
                      onClick={() => onSelectPerson(s)}
                      title={`انقر لعرض بطاقة ${s.name}`}
                    >
                      <span className="child-ordinal">{(i + 1).toLocaleString('ar')}.</span>
                      <span className="child-name-text">{s.name}</span>
                      {showIds && <span className="entry-id-tag">{s.id}</span>}
                      {showWives && mLabel && (
                        <span
                          className="child-mother-tag"
                          title={`الأم: ${mLabel}`}
                        >
                          أم: {mLabel}
                        </span>
                      )}
                      {(s.children.length > 0 || s.wives.length > 0) && (
                        <span className="child-has-record" title="له سجل في الصفحات التالية">↓</span>
                      )}
                    </span>
                  )
                })}
              </span>
            </div>
          )}
          {/* Daughters */}
          {daughters.length > 0 && (
            <div className="entry-children-col daughters-col">
              <span className="col-label">البنات ({daughters.length.toLocaleString('ar')}):</span>
              <span className="children-inline-list">
                {daughters.map((d, i) => {
                  const mLabel = motherDisplayLabel(d, person, root)
                  return (
                    <span
                      key={d.id}
                      className="child-chip female-chip is-clickable"
                      onClick={() => onSelectPerson(d)}
                      title={`انقر لعرض بطاقة ${d.name}`}
                    >
                      <span className="child-ordinal">{(i + 1).toLocaleString('ar')}.</span>
                      <span className="child-name-text">{d.name}</span>
                      {showIds && <span className="entry-id-tag">{d.id}</span>}
                      {showWives && mLabel && (
                        <span
                          className="child-mother-tag"
                          title={`الأم: ${mLabel}`}
                        >
                          أم: {mLabel}
                        </span>
                      )}
                    </span>
                  )
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* =============================================================================
   Outline Tree — compact hierarchical text tree suitable for print
   ============================================================================= */
function OutlineTree({
  node,
  showIds,
  showWives,
  root,
  onSelectPerson,
}: {
  node: OutlineNode
  showIds: boolean
  showWives: boolean
  root: Person
  onSelectPerson: (p: Person) => void
}) {
  return (
    <section className="outline-tree-body">
      <p className="register-intro-note">
        مشجر هرمي نصي مضغوط — انقر على أي شخص لعرض تفاصيله ونسبه الكامل
      </p>
      <OutlineNode
        node={node}
        showIds={showIds}
        showWives={showWives}
        root={root}
        onSelectPerson={onSelectPerson}
      />
    </section>
  )
}

function OutlineNode({
  node,
  showIds,
  showWives,
  root,
  onSelectPerson,
}: {
  node: OutlineNode
  showIds: boolean
  showWives: boolean
  root: Person
  onSelectPerson: (p: Person) => void
}) {
  const isMale = node.person.gender === 'M'
  const hasChildren = node.children.length > 0
  const depth = node.depth

  return (
    <div className={`outline-node depth-${Math.min(depth, 8)}`}>
      <div
        className={`outline-person ${isMale ? 'outline-male' : 'outline-female'} is-clickable`}
        onClick={() => onSelectPerson(node.person)}
        title={`انقر لعرض بطاقة ${node.person.name}`}
      >
        {/* Depth connector indicator */}
        {depth > 0 && (
          <span className="outline-connector" aria-hidden="true">
            {'└─'.padStart(depth * 2 + 2, '│ ')}
          </span>
        )}
        <span className={`outline-name ${isMale ? 'outline-name-male' : 'outline-name-female'}`}>
          {node.person.name}
        </span>
        {showIds && <span className="outline-id">{node.person.id}</span>}
        {showWives && isMale && node.person.wives && node.person.wives.length > 0 && (
          <span className="outline-wives">
            {node.person.wives.map((wife) => {
              const fullLabel = wifeLineageFullLabel(wife, root, 4)
              return (
                <span key={wife.id} className="outline-wife">
                  ⚭ {fullLabel}
                </span>
              )
            })}
          </span>
        )}
        {hasChildren && (
          <span className="outline-child-count">[{node.children.length}]</span>
        )}
      </div>

      {hasChildren && (
        <div className="outline-children">
          {node.children.map((child) => (
            <OutlineNode
              key={child.person.id}
              node={child}
              showIds={showIds}
              showWives={showWives}
              root={root}
              onSelectPerson={onSelectPerson}
            />
          ))}
        </div>
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
  const path = findPath(root, person.id)
  const ancestors = path.slice(0, -1).reverse() // from father upwards
  const parent = ancestors.length > 0 ? ancestors[0] : null
  const sons = person.children.filter((c) => c.gender === 'M')
  const daughters = person.children.filter((c) => c.gender === 'F')
  const generation = path.length

  // Build patronymic breadcrumb
  const lineageBreadcrumb = path.map((p) => p.name).reverse().join(' بن ')

  const motherName = useMemo(() => {
    return motherDisplayLabel(person, parent, root)
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
            <h2 className="tribute-modal-name">{person.name}</h2>
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
                {parent.name} <span className="tribute-link-id">({parent.id})</span> ↗
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
                const linked =
                  resolveWife(wife, root) ||
                  (wife.type === 'tree' && wife.personId ? findPerson(root, wife.personId) : null)
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
