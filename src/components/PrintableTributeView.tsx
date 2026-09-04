import { useState, useMemo } from 'react'
import type { Person } from '../types'
import { countPeople, resolveWife } from '../treeUtils'
import '../PrintableTribute.css'

interface PrintableTributeViewProps {
  root: Person
  treeName?: string
  onGoBack: () => void
  onGoToChart?: () => void
}

// A "family entry" = one male in DFS order, with full lineage breadcrumb
interface FamilyEntry {
  person: Person
  lineage: Person[]   // ancestors from root down to this person (inclusive)
  sons: Person[]
  daughters: Person[]
  wives: string[]
  hasDescendants: boolean
}

// Collect all males in DFS pre-order, preserving full lineage path
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
  onGoBack,
  onGoToChart,
}: PrintableTributeViewProps) {
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait')
  const [activeTab, setActiveTab] = useState<'register' | 'outline'>('register')
  const [showIds, setShowIds] = useState(true)
  const [showWives, setShowWives] = useState(true)
  const [showDedication, setShowDedication] = useState(true)
  const [showLeafEntries, setShowLeafEntries] = useState(true)

  const counts = useMemo(() => countPeople(root), [root])
  const familyEntries = useMemo(() => collectFamilyEntries(root), [root])
  const outlineRoot = useMemo(() => buildOutline(root, 0), [root])
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

  return (
    <div className="print-page-wrapper" dir="rtl">
      {/* ── Screen-Only Toolbar ── */}
      <aside className="print-toolbar-container" aria-label="أدوات الطباعة">
        <div className="print-toolbar">
          <div className="print-toolbar-group">
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

          <div className="print-toolbar-group">
            <label className="print-toggle-label">
              <input
                type="checkbox"
                checked={orientation === 'landscape'}
                onChange={(e) => setOrientation(e.target.checked ? 'landscape' : 'portrait')}
              />
              أفقي (Landscape)
            </label>
            <label className="print-toggle-label">
              <input type="checkbox" checked={showIds} onChange={(e) => setShowIds(e.target.checked)} />
              المعرفات (M001/F001)
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
            <button type="button" className="print-action-primary" onClick={() => window.print()}>
              🖨️ طباعة / حفظ PDF
            </button>
          </div>
        </div>
      </aside>

      {/* ── Printable Document ── */}
      <main className="print-stage">
        <article className={`tribute-paper ${orientation}`}>
          <div className="tribute-outer-border">
            <span className="corner-ornament corner-top-right" aria-hidden="true">❖</span>
            <span className="corner-ornament corner-top-left" aria-hidden="true">❖</span>
            <span className="corner-ornament corner-bottom-right" aria-hidden="true">❖</span>
            <span className="corner-ornament corner-bottom-left" aria-hidden="true">❖</span>

            <div className="tribute-inner-border">
              {/* ── Document Header ── */}
              <header className="tribute-header">
                <p className="tribute-basmala">بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ</p>
                <div className="tribute-title-badge">وثيقة ومشجّر نسب رسمي</div>
                <h1 className="tribute-main-title">مشجّر نسب آل {root.name}</h1>
                <p className="tribute-progenitor">
                  الجد الأعلى: <strong>{root.name}</strong>
                  {showIds && <span className="family-person-id">{root.id}</span>}
                </p>
                <div className="tribute-divider" aria-hidden="true"><span>✦ ✦ ✦</span></div>
                <p className="tribute-lineage-text">
                  «تعلّموا من أنسابكم ما تصلون به أرحامكم» — حُررت هذه الوثيقة حفظاً للصلات ورعايةً للأواصر
                </p>
              </header>

              {/* ── Dedication ── */}
              {showDedication && (
                <section className="tribute-dedication">
                  الحمد لله الذي جعل الناس شعوباً وقبائل ليتعارفوا. هذه وثيقة سلالة <strong>{root.name}</strong> وما
                  تناسل منها عبر <strong>{maxDepth.toLocaleString('ar')} أجيال</strong>، صيانةً للحقوق ووصلاً لذوي القربى.
                </section>
              )}

              {/* ── Stats ── */}
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

              {/* ── Main Content ── */}
              {activeTab === 'register' ? (
                <FamilyRegister
                  entries={visibleEntries}
                  showIds={showIds}
                  showWives={showWives}
                  root={root}
                />
              ) : (
                <OutlineTree
                  node={outlineRoot}
                  showIds={showIds}
                  showWives={showWives}
                  root={root}
                />
              )}

              {/* ── Footer Certification ── */}
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
            </div>
          </div>
        </article>
      </main>
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
  root,
}: {
  entries: FamilyEntry[]
  showIds: boolean
  showWives: boolean
  root: Person
}) {
  return (
    <section className="tribute-register-body">
      <p className="register-intro-note">
        مرتَّب حسب الفروع — كل أب يعقبه مباشرةً ذكرُ أبنائه وبناته بالترتيب
      </p>
      {entries.map((entry) => (
        <FamilyEntryCard
          key={entry.person.id}
          entry={entry}
          showIds={showIds}
          showWives={showWives}
          root={root}
        />
      ))}
    </section>
  )
}

function FamilyEntryCard({
  entry,
  showIds,
  showWives,
  root,
}: {
  entry: FamilyEntry
  showIds: boolean
  showWives: boolean
  root: Person
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
              <span className="lineage-ancestor">{p.name}</span>
              {showIds && <span className="entry-id-tag">{p.id}</span>}
            </span>
          ))}
        </p>
      )}

      {/* Father header */}
      <div className="entry-father-header">
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
          <span className="entry-wives-label">الزوجات:</span>
          {wives.map((w, idx) => {
            const linked = resolveWife(w, root)
            return (
              <span key={idx} className="entry-wife-chip">
                ⚭ {linked ? `${linked.name}${showIds ? ` (${linked.id})` : ''}` : w}
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
                {sons.map((s, i) => (
                  <span key={s.id} className="child-chip male-chip">
                    <span className="child-ordinal">{(i + 1).toLocaleString('ar')}.</span>
                    {s.name}
                    {showIds && <span className="entry-id-tag">{s.id}</span>}
                    {(s.children.length > 0 || s.wives.length > 0) && (
                      <span className="child-has-record" title="له سجل في الصفحات التالية">↓</span>
                    )}
                  </span>
                ))}
              </span>
            </div>
          )}
          {/* Daughters */}
          {daughters.length > 0 && (
            <div className="entry-children-col daughters-col">
              <span className="col-label">البنات ({daughters.length.toLocaleString('ar')}):</span>
              <span className="children-inline-list">
                {daughters.map((d, i) => (
                  <span key={d.id} className="child-chip female-chip">
                    <span className="child-ordinal">{(i + 1).toLocaleString('ar')}.</span>
                    {d.name}
                    {showIds && <span className="entry-id-tag">{d.id}</span>}
                  </span>
                ))}
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
}: {
  node: OutlineNode
  showIds: boolean
  showWives: boolean
  root: Person
}) {
  return (
    <section className="outline-tree-body">
      <p className="register-intro-note">
        مشجر هرمي نصي مضغوط — يمكن تتبع أي فرع من الجد إلى الحفيد
      </p>
      <OutlineNode node={node} showIds={showIds} showWives={showWives} root={root} />
    </section>
  )
}

function OutlineNode({
  node,
  showIds,
  showWives,
  root,
}: {
  node: OutlineNode
  showIds: boolean
  showWives: boolean
  root: Person
}) {
  const isMale = node.person.gender === 'M'
  const hasChildren = node.children.length > 0
  const depth = node.depth

  return (
    <div className={`outline-node depth-${Math.min(depth, 8)}`}>
      <div className={`outline-person ${isMale ? 'outline-male' : 'outline-female'}`}>
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
            {node.person.wives.map((w, i) => {
              const linked = resolveWife(w, root)
              return (
                <span key={i} className="outline-wife">
                  ⚭ {linked ? linked.name : w}
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
