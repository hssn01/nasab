import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ChildrenBatchForm } from './components/ChildrenBatchForm'
import { PersonEditor } from './components/PersonEditor'
import { TreeRoot } from './components/TreeView'
import { VisualTreeChart } from './components/VisualTreeChart'
import { RelationshipModal } from './components/RelationshipModal'
import { PrintableTributeView } from './components/PrintableTributeView'

import { useSessionList } from './hooks/useSessionList'
import { useSync } from './hooks/useSync'
import {
  collectMalesDFS,
  countPeople,
  exportOutline,
  findPath,
  findPerson,
} from './treeUtils'
import { useTreeBuilder, initialState } from './useTreeBuilder'
import {
  createTree,
} from './db'
import { isConfigured } from './lib/supabase'
import type { TreeState } from './types'
import './App.css'

// ── Utilities ────────────────────────────────────────────────────────────────

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function arabicCount(count: number, singular: string, plural: string) {
  return `${count.toLocaleString('ar')} ${count === 1 ? singular : plural}`
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('ar', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso))
}

function getUrlParams(): { treeId: string | null; view: 'editor' | 'chart' | 'print' } {
  const params = new URLSearchParams(window.location.search)
  const v = params.get('view')
  return {
    treeId: params.get('t'),
    view: v === 'chart' ? 'chart' : v === 'print' ? 'print' : 'editor',
  }
}

// ── App root — handles URL routing ───────────────────────────────────────────

export default function App() {
  const [route, setRoute] = useState(getUrlParams)

  useEffect(() => {
    const handler = () => setRoute(getUrlParams())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  function navigate(id: string | null, view: 'editor' | 'chart' | 'print' = 'editor') {
    let url = window.location.pathname
    if (id) {
      url += `?t=${id}`
      if (view === 'chart') url += `&view=chart`
      else if (view === 'print') url += `&view=print`
    }
    history.pushState({}, '', url)
    setRoute({ treeId: id, view: id ? view : 'editor' })
  }

  if (!route.treeId) return <HomeScreen onNavigate={(id) => navigate(id, 'editor')} />

  if (route.view === 'chart') {
    return (
      <TreeChartPage
        treeId={route.treeId}
        onGoToEditor={() => navigate(route.treeId, 'editor')}
        onGoToPrint={() => navigate(route.treeId, 'print')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  if (route.view === 'print') {
    return (
      <TreePrintPage
        treeId={route.treeId}
        onGoToEditor={() => navigate(route.treeId, 'editor')}
        onGoToChart={() => navigate(route.treeId, 'chart')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  return (
    <TreeApp
      treeId={route.treeId}
      onOpenChart={() => navigate(route.treeId, 'chart')}
      onOpenPrint={() => navigate(route.treeId, 'print')}
      onGoHome={() => navigate(null)}
    />
  )
}


// ── Home Screen ───────────────────────────────────────────────────────────────

const OLD_STORAGE_KEY = 'nasab-tree-state-v1'

function HomeScreen({ onNavigate }: { onNavigate: (id: string) => void }) {
  const {
    sessions,
    source,
    loading,
    downloadingId,
    downloadSession,
    deleteSession,
    refresh,
  } = useSessionList()

  const { isSyncing, syncNow } = useSync()
  const [creating, setCreating] = useState(false)
  const [migratingState, setMigratingState] = useState<TreeState | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  useEffect(() => {
    // Check for old localStorage data to migrate
    try {
      const raw = localStorage.getItem(OLD_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as TreeState
        if (parsed.root) setMigratingState(parsed)
      }
    } catch {
      // ignore
    }
  }, [])

  async function handleCreate() {
    setCreating(true)
    const id = await createTree('شجرة جديدة', initialState)
    setCreating(false)
    if (id) {
      onNavigate(id)
    }
  }

  async function handleMigrate() {
    if (!migratingState) return
    setMigrating(true)
    const name = migratingState.root?.name ?? 'شجرة مستعادة'
    const id = await createTree(name, migratingState)
    setMigrating(false)
    if (id) {
      localStorage.removeItem(OLD_STORAGE_KEY)
      onNavigate(id)
    }
  }

  async function handleDelete(id: string) {
    await deleteSession(id)
    setDeleteConfirm(null)
  }

  // If Supabase is not configured yet, show setup instructions
  if (!isConfigured) {
    return (
      <main className="setup" dir="rtl">
        <div className="setup-card">
          <p className="eyebrow">نَسَب · إعداد قاعدة البيانات</p>
          <h1>أضف مفاتيح Supabase</h1>
          <p className="lede">
            افتح ملف <code dir="ltr">.env.local</code> في جذر المشروع وأضف مفاتيح مشروعك:
          </p>
          <pre className="code-block" dir="ltr">{`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...`}</pre>
          <p className="lede">
            ثم شغّل هذا SQL في Supabase → SQL Editor:
          </p>
          <pre className="code-block" dir="ltr">{`create table trees (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'شجرتي',
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger trees_updated_at
  before update on trees
  for each row execute function update_updated_at();`}</pre>
          <p className="hint">بعد الإعداد، أعد تشغيل الخادم بـ <code dir="ltr">npm run dev</code></p>
        </div>
      </main>
    )
  }

  const isOffline = source === 'local' || !navigator.onLine

  return (
    <main className="home" dir="rtl">
      <header className="home-header">
        <div className="brand">
          <span className="brand-mark">ن</span>
          <span>نَسَب</span>
        </div>

        <div className="home-header-status">
          {isSyncing ? (
            <span className="sync-status-badge syncing" role="status">
              <span className="spin">⟳</span> جارٍ المزامنة السحابية…
            </span>
          ) : isOffline ? (
            <span className="sync-status-badge offline" role="status">
              ⚡ وضع عدم الاتصال (محلي)
            </span>
          ) : (
            <button
              className="sync-status-badge online"
              onClick={() => void syncNow()}
              title="انقر لتحديث المزامنة يدويًا"
            >
              ● متصل بالسحابة
            </button>
          )}
        </div>
      </header>

      <div className="home-content">
        {/* Offline notice banner */}
        {isOffline && (
          <div className="offline-banner" role="alert">
            <span className="offline-banner-icon">⚡</span>
            <div className="offline-banner-text">
              <strong>أنت غير متصل بالإنترنت</strong> — تظهر الجلسات المحمّلة فقط. يمكنك العمل وتعديلها وسيتم رفع التعديلات تلقائيًا فور عودة الاتصال.
            </div>
          </div>
        )}

        {/* Migration banner */}
        {migratingState && (
          <div className="migration-banner">
            <div>
              <p className="migration-title">وُجد عمل سابق محلّي</p>
              <p className="migration-sub">
                شجرة «{migratingState.root?.name}» موجودة على هذا الجهاز فقط — انقلها إلى السحابة لتتمكن من الوصول إليها من أي جهاز.
              </p>
            </div>
            <button
              className="primary"
              onClick={() => void handleMigrate()}
              disabled={migrating}
            >
              {migrating ? 'جارٍ النقل…' : 'نقل إلى السحابة'}
            </button>
          </div>
        )}

        <div className="home-actions">
          <div className="home-title-group">
            <h2 className="home-section-title">أشجارك وجلساتك</h2>
            <span className="home-count-pill">{sessions.length} شجرة</span>
          </div>

          <div className="home-actions-btns">
            {!isOffline && (
              <button
                className="compact-button"
                onClick={() => void refresh()}
                title="تحديث القائمة"
              >
                ↻ تحديث
              </button>
            )}
            <button
              id="btn-create-tree"
              className="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
            >
              {creating ? 'جارٍ الإنشاء…' : '+ شجرة جديدة'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="home-empty-card">
            <div className="spin" style={{ fontSize: '24px', marginBottom: '8px' }}>⟳</div>
            <p>جارٍ تحميل الجلسات…</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="home-empty-card">
            {isOffline ? (
              <>
                <p className="home-empty-title">لا توجد جلسات محمّلة محليًا</p>
                <p className="home-empty-sub">
                  أنت غير متصل بالإنترنت ولم تقم بتحميل أي جلسة مسبقًا. يمكنك إنشاء شجرة جديدة والعمل عليها محليًا.
                </p>
              </>
            ) : (
              <>
                <p className="home-empty-title">لا توجد أشجار بعد</p>
                <p className="home-empty-sub">ابدأ بإنشاء شجرة جديدة لبناء وتوثيق أنساب العائلة.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="tree-list" role="list">
            {sessions.map((session) => {
              const isDownloaded = session.downloaded === true
              const isDownloading = downloadingId === session.id

              return (
                <li key={session.id} className="tree-list-item">
                  <div className="tree-list-info">
                    <div className="tree-list-title-row">
                      <p className="tree-list-name">{session.name}</p>
                      {session.rootAncestor && session.rootAncestor !== session.name && (
                        <span className="session-root-tag" title="الجد الأساسي">
                          الأصل: {session.rootAncestor}
                        </span>
                      )}
                    </div>

                    <div className="tree-list-meta-row">
                      <span className="tree-list-date">
                        🕒 آخر تعديل: {formatDate(session.updated_at)}
                      </span>

                      {isDownloaded ? (
                        <span
                          className="session-badge downloaded"
                          title="هذه الشجرة محملة على هذا الجهاز ومتاحة للاستخدام بدون إنترنت"
                        >
                          ✓ متاح بدون إنترنت
                        </span>
                      ) : (
                        <span
                          className="session-badge cloud-only"
                          title="موجودة في السحابة فقط — حمّلها لتتمكن من فتحها بدون اتصال"
                        >
                          ☁ في السحابة
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="tree-list-actions">
                    {/* Download button for online & not downloaded */}
                    {!isOffline && !isDownloaded && (
                      <button
                        className="compact-button download-action-btn"
                        onClick={() => void downloadSession(session.id)}
                        disabled={isDownloading}
                        title="تحميل الشجرة للعمل بدون إنترنت"
                      >
                        {isDownloading ? 'جارٍ التحميل…' : '⬇ تحميل للأوفلاين'}
                      </button>
                    )}

                    {deleteConfirm === session.id ? (
                      <>
                        <button
                          className="danger-button"
                          onClick={() => void handleDelete(session.id)}
                        >
                          تأكيد الحذف
                        </button>
                        <button
                          className="compact-button"
                          onClick={() => setDeleteConfirm(null)}
                        >
                          إلغاء
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="primary open-action-btn"
                          onClick={() => onNavigate(session.id)}
                        >
                          فتح
                        </button>
                        <button
                          className="compact-button delete-action-btn"
                          onClick={() => setDeleteConfirm(session.id)}
                          title="حذف الشجرة"
                        >
                          حذف
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <p className="home-hint">
          {isOffline
            ? '💡 يمكنك تعديل الجلسات المحملة بالكامل بدون إنترنت، وستُرفع تلقائيًا فور اتصالك.'
            : '💡 قم بتحميل الجلسات (⬇) قبل مغادرة الاتصال بالإنترنت لتتمكن من تعديلها في أي وقت.'}
        </p>
      </div>
    </main>
  )
}

// ── Tree Chart Page (full screen visual diagram) ──────────────────────────────

function TreeChartPage({
  treeId,
  onGoToEditor,
  onGoToPrint,
  onGoHome,
}: {
  treeId: string
  onGoToEditor: () => void
  onGoToPrint: () => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showKinshipModal, setShowKinshipModal] = useState(false)
  const counts = tree.root ? countPeople(tree.root) : { males: 0, females: 0 }

  if (!tree.root) {
    return (
      <main className="setup" dir="rtl">
        <div className="setup-card">
          <p className="eyebrow">نَسَب</p>
          <h1>جارٍ تحميل مخطط الشجرة…</h1>
        </div>
      </main>
    )
  }

  return (
    <div className="layout-chart-page" dir="rtl">
      <header className="topbar">
        <button
          className="home-nav-button"
          onClick={onGoHome}
          title="الرئيسية"
          aria-label="العودة إلى الرئيسية"
        >
          ←
        </button>
        <div className="brand">
          <span className="brand-mark">ن</span>
          <span>نَسَب · مخطط الشجرة</span>
        </div>

        <button
          type="button"
          className="compact-button primary"
          onClick={onGoToEditor}
        >
          📝 نموذج الإدخال
        </button>

        <button
          type="button"
          className="compact-button"
          onClick={onGoToPrint}
          title="عرض وطباعة وثيقة ومشجر النسب"
        >
          🖨️ وثيقة للطباعة
        </button>

        <button
          type="button"
          className="compact-button"
          onClick={() => setShowKinshipModal(true)}
        >
          🔍 معرفة صلة القرابة
        </button>

        {tree.isOffline ? (
          <span className="sync-indicator offline" role="status" title="حفظ محلي تلقائي بدون إنترنت">
            ⚡ بدون إنترنت (حفظ محلي)
          </span>
        ) : tree.isSyncing ? (
          <span className="sync-indicator" role="status">
            ⟳ جارٍ المزامنة
          </span>
        ) : null}


        <div className="counts">
          <span>{arabicCount(counts.males, 'رجل', 'رجال')}</span>
          <span>{arabicCount(counts.females, 'امرأة', 'نساء')}</span>
        </div>
      </header>

      <main className="chart-page-body">
        <VisualTreeChart
          root={tree.root}
          selectedId={selectedId}
          currentId={tree.currentPersonId}
          onSelectPerson={(person) => setSelectedId(person.id)}
          onGoToEditorForPerson={() => onGoToEditor()}
          onRenamePerson={(personId, name) => tree.renamePerson(personId, name)}
          onAddChildrenBatch={(personId, sons, daughters) =>
            tree.setChildren(personId, sons, daughters)
          }
          onDeletePerson={(personId) => tree.deletePerson(personId)}
          onAddWife={(personId, wifeNameOrId) => tree.addWifeToPerson(personId, wifeNameOrId)}
          onRemoveWife={(personId, index) => tree.removeWifeFromPerson(personId, index)}
        />
      </main>

      {showKinshipModal && (
        <RelationshipModal
          root={tree.root}
          initialPersonAId={selectedId || undefined}
          onClose={() => setShowKinshipModal(false)}
          onSelectPerson={(person) => setSelectedId(person.id)}
        />
      )}
    </div>
  )
}

// ── Tree Print Page (archival printable tribute & chart) ──────────────────────

function TreePrintPage({
  treeId,
  onGoToEditor,
  onGoToChart,
  onGoHome,
}: {
  treeId: string
  onGoToEditor: () => void
  onGoToChart: () => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)

  if (!tree.root) {
    return (
      <main className="setup" dir="rtl">
        <div className="setup-card">
          <button className="back-button" onClick={onGoHome} type="button">
            → العودة إلى الرئيسية
          </button>
          <p className="eyebrow">نَسَب</p>
          <h1>جارٍ إعداد الوثيقة للطباعة…</h1>
        </div>
      </main>
    )
  }

  return (
    <PrintableTributeView
      root={tree.root}
      treeName={`وثيقة نسب آل ${tree.root.name}`}
      onGoBack={onGoToEditor}
      onGoToChart={onGoToChart}
    />
  )
}
// ── Tree App (the main editor) ────────────────────────────────────────────────


function TreeApp({
  treeId,
  onOpenChart,
  onOpenPrint,
  onGoHome,
}: {
  treeId: string
  onOpenChart: () => void
  onOpenPrint: () => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)
  const sidebarRef = useRef<HTMLElement>(null)
  const resizeRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    anchoredLeft: boolean
  } | null>(null)
  const [rootName, setRootName] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('nasab-sidebar-width'))
    return Number.isFinite(saved) && saved >= 260 && saved <= 560 ? saved : 320
  })


  const males = useMemo(
    () => (tree.root ? collectMalesDFS(tree.root) : []),
    [tree.root],
  )
  const counts = tree.root ? countPeople(tree.root) : { males: 0, females: 0 }

  const selectedPerson = useMemo(() => {
    if (!tree.root) return null
    const id = selectedId ?? tree.currentPersonId
    return id ? findPerson(tree.root, id) : null
  }, [selectedId, tree.currentPersonId, tree.root])

  const selectedLineage = useMemo(() => {
    if (!tree.root || !selectedPerson) return []
    return findPath(tree.root, selectedPerson.id)
  }, [selectedPerson, tree.root])

  const lineageText = useMemo(
    () =>
      [...selectedLineage]
        .reverse()
        .map((person) => person.name)
        .join(' بن '),
    [selectedLineage],
  )

  async function importJson(file: File) {
    try {
      const value: unknown = JSON.parse(await file.text())
      if (!tree.importProject(value)) throw new Error('invalid tree')
      setSelectedId(null)
      setImportMessage('تم استيراد الشجرة')
    } catch {
      setImportMessage('تعذّر استيراد الملف')
    }
    window.setTimeout(() => setImportMessage(null), 2500)
  }

  const visitedIds = useMemo(() => {
    if (!tree.currentPersonId) return new Set(males.map((male) => male.id))
    const index = males.findIndex((male) => male.id === tree.currentPersonId)
    return new Set(males.slice(0, Math.max(0, index)).map((male) => male.id))
  }, [males, tree.currentPersonId])

  function showSaved(personId: string) {
    setSavedId(personId)
    window.setTimeout(() => setSavedId(null), 1800)
  }

  function updateSidebarWidth(width: number) {
    const maximum = Math.max(260, Math.min(560, window.innerWidth - 420))
    const next = Math.round(Math.min(maximum, Math.max(260, width)))
    setSidebarWidth(next)
    localStorage.setItem('nasab-sidebar-width', String(next))
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const bounds = sidebar.getBoundingClientRect()
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: bounds.width,
      anchoredLeft: bounds.left < window.innerWidth / 2,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resizeSidebar(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const movement = event.clientX - resize.startX
    updateSidebarWidth(
      resize.startWidth + (resize.anchoredLeft ? movement : -movement),
    )
  }

  function stopSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // ── Setup screen (new tree, no root yet) ──
  if (tree.phase === 'setup' || !tree.root) {
    return (
      <main className="setup" dir="rtl">
        <div className="setup-card">
          <button className="back-button" onClick={onGoHome} type="button">
            → العودة إلى الرئيسية
          </button>
          <p className="eyebrow">نَسَب</p>
          <h1>أنشئ شجرة النسب</h1>
          <p className="lede">
            ابدأ بالجد الأعلى، ثم أدخل أبناء وبنات كل رجل كما وردوا في الكتاب.
          </p>
          <form
            className="entry-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (rootName.trim()) tree.startRoot(rootName)
            }}
          >
            <div className="input-row">
              <input
                type="text"
                dir="rtl"
                autoFocus
                value={rootName}
                placeholder="اسم الجد الأعلى"
                onChange={(event) => setRootName(event.target.value)}
                autoComplete="off"
              />
              <button type="submit" className="primary">
                ابدأ
              </button>
            </div>
            <p className="hint">
              سيُسجّل بالمعرّف <span className="badge badge-m">M001</span>
            </p>
          </form>
        </div>
      </main>
    )
  }

  const isComplete = tree.phase === 'complete'
  const isEditingEarlier =
    selectedId !== null && selectedId !== tree.currentPersonId

  return (
    <div
      className="layout"
      dir="rtl"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <header className="topbar">
        <button
          className="home-nav-button"
          onClick={onGoHome}
          title="الرئيسية"
          aria-label="العودة إلى الرئيسية"
        >
          ←
        </button>
        <div className="brand">
          <span className="brand-mark">ن</span>
          <span>نَسَب</span>
        </div>

        <button
          type="button"
          className="compact-button"
          onClick={onOpenChart}
          title="فتح مخطط الشجرة المرئي"
        >
          🌳 مخطط الشجرة
        </button>

        <button
          type="button"
          className="compact-button"
          onClick={onOpenPrint}
          title="عرض وطباعة وثيقة ومشجر النسب"
        >
          🖨️ وثيقة للطباعة
        </button>


        {tree.isSyncing && (
          <span className="sync-indicator" role="status" aria-live="polite">
            ⟳ جارٍ المزامنة
          </span>
        )}
        <div className="phases" aria-label="مراحل العمل">
          <span className={`phase${!isComplete ? ' active' : ''}`}>
            ١ · الأبناء والبنات
          </span>
          <span className="phase">٢ · الزوجات والأمهات لاحقاً</span>
          <span className={`phase${isComplete ? ' active' : ''}`}>
            ٣ · المراجعة
          </span>
        </div>
        <div className="counts">
          <span>{arabicCount(counts.males, 'رجل', 'رجال')}</span>
          <span>{arabicCount(counts.females, 'امرأة', 'نساء')}</span>
        </div>
      </header>

      <main className="panel">
        {selectedPerson ? (
          <>
            {savedId === selectedPerson.id && (
              <p className="save-notice" role="status">
                تم الحفظ
              </p>
            )}
            {selectedPerson.gender === 'M' ? (
              <ChildrenBatchForm
                key={selectedPerson.id}
                person={selectedPerson}
                lineageText={lineageText}
                isCurrent={!isEditingEarlier && !isComplete}
                canDelete={selectedPerson.id !== tree.root.id}
                onRename={(name) => tree.renamePerson(selectedPerson.id, name)}
                onSave={(sons, daughters) => {
                  tree.setChildren(selectedPerson.id, sons, daughters)
                  showSaved(selectedPerson.id)
                }}
                onSaveAndContinue={(sons, daughters) => {
                  tree.setChildrenAndContinue(sons, daughters)
                  setSelectedId(null)
                }}
                onDelete={() => {
                  tree.deletePerson(selectedPerson.id)
                  setSelectedId(null)
                }}
                onReturnToCurrent={() => setSelectedId(null)}
              />
            ) : (
              <PersonEditor
                key={selectedPerson.id}
                person={selectedPerson}
                onRename={(name) => {
                  tree.renamePerson(selectedPerson.id, name)
                  showSaved(selectedPerson.id)
                }}
                onDelete={() => {
                  tree.deletePerson(selectedPerson.id)
                  setSelectedId(null)
                }}
                onBack={() => setSelectedId(null)}
              />
            )}
          </>
        ) : (
          <section className="stage complete-stage">
            <p className="eyebrow">اكتمل إدخال الأشخاص</p>
            <h2>أصبحت الشجرة جاهزة للمراجعة</h2>
            <p className="lede">
              سُجّل {arabicCount(counts.males, 'رجل', 'رجال')} و
              {arabicCount(counts.females, 'امرأة', 'نساء')}. اختر أي رجل من
              الشجرة لتعديل أبنائه وبناته.
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={onOpenPrint}
                title="عرض وطباعة وثيقة ومشجر النسب"
              >
                🖨️ طباعة وثيقة النسب
              </button>
              <button
                onClick={() =>
                  download(
                    'nasab.json',
                    tree.exportProject(),
                    'application/json',
                  )
                }
              >
                تنزيل JSON
              </button>
              <button
                onClick={() =>
                  download(
                    'nasab.txt',
                    exportOutline(tree.root!),
                    'text/plain',
                  )
                }
              >
                تنزيل النص
              </button>
              <button className="ghost" onClick={onGoHome}>
                شجرة أخرى
              </button>
            </div>
          </section>
        )}
      </main>

      <aside className="sidebar" ref={sidebarRef}>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="تغيير عرض شجرة الأشخاص"
          aria-orientation="vertical"
          aria-valuemin={260}
          aria-valuemax={560}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
          onDoubleClick={() => updateSidebarWidth(320)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              updateSidebarWidth(sidebarWidth + 20)
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              updateSidebarWidth(sidebarWidth - 20)
            }
            if (event.key === 'Home') updateSidebarWidth(260)
            if (event.key === 'End') updateSidebarWidth(560)
          }}
        />
        <div className="sidebar-heading">
          <div>
            <p className="eyebrow">الفهرس</p>
            <h3>شجرة الأشخاص</h3>
          </div>
          {selectedId && (
            <button className="compact-button" onClick={() => setSelectedId(null)}>
              موضع الإدخال
            </button>
          )}
        </div>
        <div className="data-actions">
          <button
            className="compact-button"
            onClick={() =>
              download(
                'nasab-backup.json',
                tree.exportProject(),
                'application/json',
              )
            }
          >
            تصدير JSON
          </button>
          <label className="compact-button import-button">
            استيراد JSON
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importJson(file)
                event.target.value = ''
              }}
            />
          </label>
          {importMessage && (
            <span className="import-message" role="status">
              {importMessage}
            </span>
          )}
        </div>
        <p className="tree-help">اختر أي رجل لمراجعة أبنائه وبناته.</p>
        <TreeRoot
          person={tree.root}
          currentId={tree.currentPersonId}
          selectedId={selectedId ?? tree.currentPersonId}
          visitedIds={visitedIds}
          onSelect={(person) => {
            setSelectedId(person.id)
          }}
        />
      </aside>

    </div>
  )
}
