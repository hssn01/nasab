import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { ChildrenBatchForm } from './components/ChildrenBatchForm'
import { WivesBatchForm } from './components/WivesBatchForm'
import { MothersAssignForm } from './components/MothersAssignForm'
import { PersonEditor } from './components/PersonEditor'
import { TreeRoot } from './components/TreeView'
import { VisualTreeChart } from './components/VisualTreeChart'
import { PrintableTributeView } from './components/PrintableTributeView'
import { PublicViewerPortal } from './components/PublicViewerPortal'
import { LinkTreeModal } from './components/LinkTreeModal'

import { useSessionList } from './hooks/useSessionList'
import { useSync } from './hooks/useSync'
import { useUnifiedTree } from './hooks/useUnifiedTree'
import {
  advanceAfterDone,
  collectMalesDFS,
  countPeople,
  exportOutline,
  findPath,
  findPerson,
} from './treeUtils'
import { useTreeBuilder, initialState } from './useTreeBuilder'
import {
  createTree,
  updateTreeLink,
} from './db'
import { isConfigured } from './lib/supabase'
import type { Person, TreeLink, TreeMeta, TreeState } from './types'
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

function getUrlParams(): { treeId: string | null; view: 'editor' | 'chart' | 'print' | 'viewer' } {
  const params = new URLSearchParams(window.location.search)
  const v = params.get('view')
  return {
    treeId: params.get('t'),
    view: v === 'viewer' ? 'viewer' : v === 'chart' ? 'chart' : v === 'print' ? 'print' : 'editor',
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

  if (route.view === 'viewer' || window.location.pathname.endsWith('/viewer')) {
    return <PublicViewerPortal initialTreeId={route.treeId} />
  }

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
        onOpenTree={(id) => navigate(id, 'print')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  return (
    <TreeApp
      treeId={route.treeId}
      onOpenChart={() => navigate(route.treeId, 'chart')}
      onOpenPrint={() => navigate(route.treeId, 'print')}
      onOpenTree={(id) => navigate(id, 'editor')}
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
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [linkModalTargetTree, setLinkModalTargetTree] = useState<TreeMeta | null>(null)

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

  async function handleCreateLinkedTree(name: string, state: TreeState, link: TreeLink) {
    setCreating(true)
    const id = await createTree(name, state, link)
    setCreating(false)
    if (id) {
      await refresh()
      onNavigate(id)
    }
    return id
  }

  async function handleLinkExistingTree(treeId: string, link: TreeLink | null) {
    await updateTreeLink(treeId, link)
    await refresh()
  }

  function openLinkModal(tree?: TreeMeta) {
    setLinkModalTargetTree(tree || null)
    setIsLinkModalOpen(true)
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

  const mainTrees = useMemo(() => sessions.filter((s) => !s.linkedFrom), [sessions])
  const linkedTrees = useMemo(() => sessions.filter((s) => !!s.linkedFrom), [sessions])
  const mainTreeIds = useMemo(() => new Set(mainTrees.map((m) => m.id)), [mainTrees])
  const orphanLinkedTrees = useMemo(
    () => linkedTrees.filter((b) => !mainTreeIds.has(b.linkedFrom!.mainTreeId)),
    [linkedTrees, mainTreeIds]
  )

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
              className="compact-button"
              onClick={() => window.open('?view=viewer', '_blank')}
              title="فتح بوابة الزوار العامة المخصصة للقراءة والطباعة فقط دون إمكانية التعديل"
              style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
            >
              👁️ بوابة الزوار (للقراءة فقط)
            </button>
            <button
              className="compact-button link-header-action-btn"
              onClick={() => openLinkModal()}
              title="إضافة فرع عائلي مرتبط (بنت / أخ) أو ربط شجرة قائمة"
            >
              🔗 + إضافة فرع مرتبط
            </button>
            <button
              id="btn-create-tree"
              className="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
            >
              {creating ? 'جارٍ الإنشاء…' : '+ شجرة رئيسية'}
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
                <p className="home-empty-sub">ابدأ بإنشاء شجرة رئيسية لبناء وتوثيق أنساب العائلة، ثم أضف الأفرع المرتبطة.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="tree-list" role="list">
            {mainTrees.map((session) => {
              const isDownloaded = session.downloaded === true
              const isDownloading = downloadingId === session.id
              const branches = linkedTrees.filter((b) => b.linkedFrom?.mainTreeId === session.id)

              return (
                <li key={session.id} className="tree-list-item main-tree-item">
                  <div className="tree-list-main-card">
                    <div className="tree-list-info">
                      <div className="tree-list-title-row">
                        <p className="tree-list-name">{session.name}</p>
                        {session.rootAncestor && session.rootAncestor !== session.name && (
                          <span className="session-root-tag" title="الجد الأساسي">
                            الأصل: {session.rootAncestor}
                          </span>
                        )}
                        {branches.length > 0 && (
                          <span className="session-branches-count-badge">
                            🌿 {branches.length} {branches.length === 1 ? 'فرع مرتبط' : 'أفرع مرتبطة'}
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
                            فتح المحرر
                          </button>
                          <button
                            className="compact-button viewer-action-btn"
                            onClick={() => window.open(`?t=${session.id}&view=viewer`, '_blank')}
                            title="فتح دليل العائلة المخصص للمستخدمين بدون محرر"
                          >
                            📱 عرض الدليل العائلي
                          </button>
                          <button
                            className="compact-button link-branch-btn"
                            onClick={() => openLinkModal(session)}
                            title="إضافة فرع مرتبط (بنت / أخ) أو ربط شجرة بهذا الأصل"
                          >
                            🔗 + فرع مرتبط
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
                  </div>

                  {/* ── Nested branches list ── */}
                  {branches.length > 0 && (
                    <div className="tree-branches-wrapper">
                      <div className="tree-branches-indicator">
                        <span className="tree-branch-arrow">↳</span>
                        <span className="tree-branches-label">الأفرع والشجرات المتصلة بهذا الأصل:</span>
                      </div>
                      <ul className="tree-branches-sublist">
                        {branches.map((branch) => {
                          const l = branch.linkedFrom!
                          const bDownloaded = branch.downloaded === true
                          const bDownloading = downloadingId === branch.id

                          return (
                            <li key={branch.id} className="tree-branch-item">
                              <div className="tree-branch-info">
                                <div className="tree-branch-title-line">
                                  <span className={`link-badge-pill ${l.type}`}>
                                    {l.type === 'daughter-branch'
                                      ? '🧬 فرع بنت'
                                      : l.type === 'brother-branch'
                                      ? '🤝 فرع أخ الجد'
                                      : '🌿 فرع مرتبط'}
                                  </span>
                                  <strong className="tree-branch-title">{branch.name}</strong>
                                  {l.personName && (
                                    <span className="tree-branch-person-tag">
                                      ({l.personName})
                                    </span>
                                  )}
                                </div>
                                {l.note && <p className="tree-branch-note-text">{l.note}</p>}
                                <div className="tree-branch-meta-line">
                                  <span className="tree-list-date">
                                    🕒 {formatDate(branch.updated_at)}
                                  </span>
                                  {bDownloaded ? (
                                    <span className="session-badge downloaded-mini">✓ محلي</span>
                                  ) : (
                                    <span className="session-badge cloud-mini">☁ سحابي</span>
                                  )}
                                </div>
                              </div>

                              <div className="tree-branch-actions">
                                {!isOffline && !bDownloaded && (
                                  <button
                                    className="compact-button download-action-btn"
                                    onClick={() => void downloadSession(branch.id)}
                                    disabled={bDownloading}
                                    title="تحميل للأوفلاين"
                                  >
                                    {bDownloading ? '…' : '⬇'}
                                  </button>
                                )}
                                <button
                                  className="compact-button primary"
                                  onClick={() => onNavigate(branch.id)}
                                >
                                  فتح المحرر
                                </button>
                                <button
                                  className="compact-button viewer-action-btn"
                                  onClick={() => window.open(`?t=${branch.id}&view=viewer`, '_blank')}
                                  title="عرض الدليل العائلي"
                                >
                                  📱 الدليل
                                </button>
                                {deleteConfirm === branch.id ? (
                                  <>
                                    <button
                                      className="danger-button"
                                      onClick={() => void handleDelete(branch.id)}
                                    >
                                      تأكيد
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
                                      className="compact-button delete-action-btn"
                                      onClick={() => setDeleteConfirm(branch.id)}
                                      title="حذف هذا الفرع"
                                    >
                                      حذف
                                    </button>
                                    <button
                                      className="compact-button unlink-action-btn"
                                      onClick={() => void handleLinkExistingTree(branch.id, null)}
                                      title="فك ارتباط هذا الفرع ليصبح شجرة رئيسية مستقلة"
                                    >
                                      فك الارتباط
                                    </button>
                                  </>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              )
            })}

            {/* ── Standalone / Orphaned linked trees if any ── */}
            {orphanLinkedTrees.length > 0 && (
              <div className="orphan-branches-block">
                <h3 className="orphan-branches-title">أفرع وشجرات مرتبطة أخرى</h3>
                {orphanLinkedTrees.map((branch) => {
                  const l = branch.linkedFrom!
                  const isDownloaded = branch.downloaded === true
                  const isDownloading = downloadingId === branch.id

                  return (
                    <li key={branch.id} className="tree-list-item orphan-tree-item">
                      <div className="tree-list-info">
                        <div className="tree-list-title-row">
                          <span className={`link-badge-pill ${l.type}`}>
                            {l.type === 'daughter-branch'
                              ? '🧬 فرع بنت'
                              : l.type === 'brother-branch'
                              ? '🤝 فرع أخ الجد'
                              : '🌿 فرع مرتبط'}
                          </span>
                          <p className="tree-list-name">{branch.name}</p>
                          <span className="session-root-tag">
                            الأصل: {l.mainTreeName}
                          </span>
                        </div>
                        <div className="tree-list-meta-row">
                          <span className="tree-list-date">
                            🕒 آخر تعديل: {formatDate(branch.updated_at)}
                          </span>
                        </div>
                      </div>
                      <div className="tree-list-actions">
                        {!isOffline && !isDownloaded && (
                          <button
                            className="compact-button download-action-btn"
                            onClick={() => void downloadSession(branch.id)}
                            disabled={isDownloading}
                          >
                            ⬇ للأوفلاين
                          </button>
                        )}
                        <button
                          className="primary open-action-btn"
                          onClick={() => onNavigate(branch.id)}
                        >
                          فتح المحرر
                        </button>
                        <button
                          className="compact-button"
                          onClick={() => void handleLinkExistingTree(branch.id, null)}
                          title="فك الارتباط"
                        >
                          فك الارتباط
                        </button>
                      </div>
                    </li>
                  )
                })}
              </div>
            )}
          </ul>
        )}

        <p className="home-hint">
          {isOffline
            ? '💡 يمكنك تعديل الجلسات المحملة بالكامل بدون إنترنت، وستُرفع تلقائيًا فور اتصالك.'
            : '💡 قم بتحميل الجلسات (⬇) قبل مغادرة الاتصال بالإنترنت لتتمكن من تعديلها في أي وقت.'}
        </p>
      </div>

      {/* Link Tree Modal */}
      <LinkTreeModal
        isOpen={isLinkModalOpen}
        onClose={() => setIsLinkModalOpen(false)}
        mainTree={linkModalTargetTree}
        allTrees={sessions}
        onCreateLinkedTree={handleCreateLinkedTree}
        onLinkExistingTree={handleLinkExistingTree}
      />
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
  const { sessions, refresh } = useSessionList()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [showUnifiedView, setShowUnifiedView] = useState(true)
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [linkModalPerson, setLinkModalPerson] = useState<Person | null>(null)
  const [linkModalTargetBranchId, setLinkModalTargetBranchId] = useState<string | null>(null)
  const counts = tree.root ? countPeople(tree.root) : { males: 0, females: 0 }

  const mainTreeName = tree.root ? `شجرة ${tree.root.name}` : 'الشجرة الرئيسية'
  const currentTreeMeta = useMemo(() => sessions.find((s) => s.id === treeId) || null, [sessions, treeId])

  async function handleCreateLinkedTree(name: string, state: TreeState, link: TreeLink) {
    const id = await createTree(name, state, link)
    if (id) {
      await refresh()
      setShowUnifiedView(true)
    }
    return id
  }

  async function handleLinkExistingTree(branchTreeId: string, link: TreeLink | null) {
    await updateTreeLink(branchTreeId, link)
    await refresh()
    setShowUnifiedView(true)
  }

  const { unifiedResult, isLoading: isLoadingUnified, hasConnectedBranches, branchCount } = useUnifiedTree({
    mainTreeId: treeId,
    mainRoot: tree.root ?? null,
    mainTreeName,
    sessions,
    enabled: showUnifiedView,
  })

  const displayRoot = showUnifiedView && unifiedResult ? unifiedResult.root : tree.root

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

  if (!displayRoot) {
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

        {hasConnectedBranches && (
          <button
            type="button"
            className={`compact-button${showUnifiedView ? ' primary' : ''}`}
            onClick={() => setShowUnifiedView((v) => !v)}
            title={showUnifiedView ? 'عرض الشجرة الحالية فقط' : `عرض كل الأشجار المرتبطة (${branchCount} فرع) في مخطط واحد`}
          >
            {isLoadingUnified ? '⟳ جارٍ الدمج…' : showUnifiedView ? '🌐 عرض موحد ✓' : `🌐 عرض موحد (${branchCount})`}
          </button>
        )}

        {currentTreeMeta?.linkedFrom ? (
          <div className="linked-tree-header-badge">
            <span className="badge-icon">
              {currentTreeMeta.linkedFrom.type === 'daughter-branch' ? '🧬' : '🤝'}
            </span>
            <span>
              متصلة بـ «{currentTreeMeta.linkedFrom.mainTreeName}»
              {currentTreeMeta.linkedFrom.personName ? ` (أم/صلة: ${currentTreeMeta.linkedFrom.personName})` : ''}
            </span>
            <button
              type="button"
              className="unlink-mini-btn"
              onClick={() => void handleLinkExistingTree(treeId, null)}
              title="فك الارتباط لتصبح هذه الشجرة مستقلة ومنفصلة تماماً"
            >
              ✂️ فك الارتباط (جعلها مستقلة)
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="compact-button"
            onClick={() => {
              setLinkModalTargetBranchId(treeId)
              setLinkModalPerson(null)
              setIsLinkModalOpen(true)
            }}
            title="ربط هذه الشجرة كفرع لشجرة أخرى (مثال: أخت الجد الخامس هي أم لهذه الشجرة)"
          >
            🔗 ربط هذه الشجرة كفرع بشجرة أخرى
          </button>
        )}




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
        {showUnifiedView && unifiedResult?.isUnified && (
          <div className="unified-view-banner" role="status">
            🌐 <strong>عرض موحد:</strong> تشمل هذه الشجرة {unifiedResult.connectedTreeIds.length} شجرة مدمجة — {unifiedResult.branchCount} فرع مرتبط. الأفرع تظهر بشارات ملونة.
          </div>
        )}
        <VisualTreeChart
          root={displayRoot}
          isUnifiedView={showUnifiedView && !!unifiedResult?.isUnified}
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
          onLinkBranchForPerson={(person) => {
            setLinkModalPerson(person)
            setLinkModalTargetBranchId(null)
            setIsLinkModalOpen(true)
          }}
        />
      </main>

      {/* Link Branch Modal from within the chart */}
      <LinkTreeModal
        isOpen={isLinkModalOpen}
        onClose={() => {
          setIsLinkModalOpen(false)
          setLinkModalPerson(null)
          setLinkModalTargetBranchId(null)
        }}
        mainTree={linkModalTargetBranchId ? null : currentTreeMeta}
        allTrees={sessions}
        initialPerson={linkModalPerson}
        targetBranchTreeId={linkModalTargetBranchId}
        onCreateLinkedTree={handleCreateLinkedTree}
        onLinkExistingTree={handleLinkExistingTree}
      />


    </div>
  )
}

// ── Tree Print Page (archival printable tribute & chart) ──────────────────────

function TreePrintPage({
  treeId,
  onGoToEditor,
  onGoToChart,
  onOpenTree,
  onGoHome,
}: {
  treeId: string
  onGoToEditor: () => void
  onGoToChart: () => void
  onOpenTree?: (treeId: string) => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)
  const { sessions } = useSessionList()
  const linkedTrees = useMemo(
    () => sessions.filter((s) => s.linkedFrom?.mainTreeId === treeId),
    [sessions, treeId]
  )

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
      linkedFrom={tree.linkedFrom}
      linkedTrees={linkedTrees}
      onGoBack={onGoToEditor}
      onGoToChart={onGoToChart}
      onOpenTree={onOpenTree}
    />
  )
}
// ── Tree App (the main editor) ────────────────────────────────────────────────


function TreeApp({
  treeId,
  onOpenChart,
  onOpenPrint,
  onOpenTree,
  onGoHome,
}: {
  treeId: string
  onOpenChart: () => void
  onOpenPrint: () => void
  onOpenTree?: (treeId: string) => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)
  const { sessions, refresh } = useSessionList()
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const currentTreeMeta = useMemo(() => sessions.find((s) => s.id === treeId) || null, [sessions, treeId])

  async function handleLinkExistingTree(branchTreeId: string, link: TreeLink | null) {
    await updateTreeLink(branchTreeId, link)
    await refresh()
  }

  async function handleCreateLinkedTree(name: string, state: TreeState, link: TreeLink) {
    const id = await createTree(name, state, link)
    if (id) await refresh()
    return id
  }

  const sidebarRef = useRef<HTMLElement>(null)
  const resizeRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
    anchoredLeft: boolean
  } | null>(null)
  const [rootName, setRootName] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reviewFocus, setReviewFocus] = useState<'children' | 'wives' | 'mothers'>(
    'children',
  )
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

    if (tree.phase === 'add-wives' && tree.malesQueue.length > 0) {
      const index = tree.malesQueue.indexOf(tree.currentPersonId)
      const visitedCount = index >= 0 ? index : tree.currentMaleIndex
      return new Set(tree.malesQueue.slice(0, Math.max(0, visitedCount)))
    }

    const index = males.findIndex((male) => male.id === tree.currentPersonId)
    return new Set(males.slice(0, Math.max(0, index)).map((male) => male.id))
  }, [males, tree.currentMaleIndex, tree.currentPersonId, tree.malesQueue, tree.phase])

  const childrenContinueLabel = useMemo(() => {
    if (!tree.root || !tree.currentPersonId || tree.phase !== 'enter-children') {
      return undefined
    }
    const next = advanceAfterDone(tree.currentPersonId, tree.root)
    return next === 'phase2'
      ? 'حفظ والانتقال إلى الزوجات'
      : 'حفظ والانتقال للتالي'
  }, [tree.currentPersonId, tree.phase, tree.root])

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

  const isWivesPhase = tree.phase === 'add-wives'
  const isChildrenPhase = tree.phase === 'enter-children'

  const activeFocus = useMemo(() => {
    if (isChildrenPhase) {
      return reviewFocus === 'wives' || reviewFocus === 'mothers' ? reviewFocus : 'children'
    }
    if (isWivesPhase) {
      return reviewFocus === 'children' || reviewFocus === 'mothers' ? reviewFocus : 'wives'
    }
    return reviewFocus
  }, [isChildrenPhase, isWivesPhase, reviewFocus])

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
          {tree.linkedFrom && (
            <div className="setup-linked-banner">
              <span className="badge-icon">
                {tree.linkedFrom.type === 'daughter-branch'
                  ? '🧬'
                  : tree.linkedFrom.type === 'brother-branch'
                  ? '🤝'
                  : '🌿'}
              </span>
              <div>
                <strong>
                  {tree.linkedFrom.type === 'daughter-branch'
                    ? `فرع بنت: ${tree.linkedFrom.personName || ''}`
                    : tree.linkedFrom.type === 'brother-branch'
                    ? `فرع أخ الجد الأكبر: ${tree.linkedFrom.personName || ''}`
                    : 'فرع عائلي مرتبط'}
                </strong>
                <p>متصل بالشجرة الرئيسية «{tree.linkedFrom.mainTreeName}»</p>
              </div>
            </div>
          )}
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

  const showWivesForm = activeFocus === 'wives'
  const showMothersForm = activeFocus === 'mothers'

  const wivesProgressLabel = isWivesPhase
    ? `${(tree.currentMaleIndex + 1).toLocaleString('ar')} / ${tree.malesQueue.length.toLocaleString('ar')}`
    : ''

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

        {(tree.linkedFrom || currentTreeMeta?.linkedFrom) ? (
          <div className="linked-tree-header-badge">
            <button
              type="button"
              className="linked-tree-nav-btn"
              onClick={() => {
                const mainId = (tree.linkedFrom || currentTreeMeta?.linkedFrom)!.mainTreeId
                if (onOpenTree) onOpenTree(mainId)
              }}
              title={`الانتقال إلى الشجرة الرئيسية «${(tree.linkedFrom || currentTreeMeta?.linkedFrom)!.mainTreeName}»`}
            >
              <span className="badge-icon">
                {(tree.linkedFrom || currentTreeMeta?.linkedFrom)!.type === 'daughter-branch' ? '🧬' : '🤝'}
              </span>
              <span>
                متصلة بـ «{(tree.linkedFrom || currentTreeMeta?.linkedFrom)!.mainTreeName}»
                {(tree.linkedFrom || currentTreeMeta?.linkedFrom)!.personName ? ` (أم/صلة: ${(tree.linkedFrom || currentTreeMeta?.linkedFrom)!.personName})` : ''}
              </span>
            </button>
            <button
              type="button"
              className="unlink-mini-btn"
              onClick={() => void handleLinkExistingTree(treeId, null)}
              title="فك الارتباط لتصبح هذه الشجرة مستقلة ومنفصلة تماماً"
            >
              ✂️ فك الارتباط (جعلها مستقلة)
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="compact-button"
            onClick={() => setIsLinkModalOpen(true)}
            title="ربط هذه الشجرة كفرع لشجرة أخرى (مثلاً: أخت الجد الخامس هي أم لهذه الشجرة)"
          >
            🔗 ربط كفرع بشجرة أخرى
          </button>
        )}

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
          <button
            type="button"
            className={`phase-button phase${isChildrenPhase ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('enter-children')
              setReviewFocus('children')
            }}
            title="الانتقال إلى مرحلة إدخال الأبناء والبنات"
          >
            ١ · الأبناء والبنات
          </button>
          <button
            type="button"
            className={`phase-button phase${isWivesPhase ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('add-wives')
              setReviewFocus('wives')
            }}
            title="الانتقال إلى مرحلة إدخال الزوجات"
          >
            ٢ · الزوجات
          </button>
          <button
            type="button"
            className={`phase-button phase${isComplete ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('complete')
            }}
            title="الانتقال إلى مرحلة المراجعة"
          >
            ٣ · المراجعة
          </button>
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
              <>
                <div className="review-focus" role="tablist" aria-label="نوع التعديل">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFocus === 'children'}
                    className={`compact-button${activeFocus === 'children' ? ' primary' : ''}`}
                    onClick={() => setReviewFocus('children')}
                  >
                    الأبناء والبنات ({selectedPerson.children.length.toLocaleString('ar')})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFocus === 'wives'}
                    className={`compact-button${activeFocus === 'wives' ? ' primary' : ''}`}
                    onClick={() => setReviewFocus('wives')}
                  >
                    الزوجات ({selectedPerson.wives.length.toLocaleString('ar')})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeFocus === 'mothers'}
                    className={`compact-button${activeFocus === 'mothers' ? ' primary' : ''}`}
                    onClick={() => setReviewFocus('mothers')}
                  >
                    الأمهات
                  </button>
                </div>
                {showWivesForm ? (
                  <WivesBatchForm
                    key={`wives-${selectedPerson.id}`}
                    person={selectedPerson}
                    root={tree.root}
                    lineageText={lineageText}
                    isCurrent={!isEditingEarlier && isWivesPhase}
                    progressLabel={wivesProgressLabel}
                    currentTreeId={treeId}
                    currentTreeName={tree.root ? `شجرة ${tree.root.name}` : undefined}
                    availableTrees={sessions}
                    onRename={(name) => tree.renamePerson(selectedPerson.id, name)}
                    onSave={(wives) => {
                      tree.setWives(selectedPerson.id, wives)
                      showSaved(selectedPerson.id)
                    }}
                    onSaveAndContinue={(wives) => {
                      tree.setWivesAndContinue(wives)
                      setSelectedId(null)
                    }}
                    onReturnToCurrent={() => setSelectedId(null)}
                    onSwitchToChildren={() => setReviewFocus('children')}
                    onAddDaughter={(fatherId, daughterName) => {
                      const newId = tree.addChildToPerson(fatherId, daughterName, 'F')
                      if (newId) {
                        showSaved(fatherId)
                      }
                      return newId
                    }}
                  />
                ) : showMothersForm ? (
                  <MothersAssignForm
                    key={`mothers-${selectedPerson.id}-${selectedPerson.wives.map((w) => w.id).join('|')}`}
                    person={selectedPerson}
                    root={tree.root}
                    lineageText={lineageText}
                    onSave={(assignments) => {
                      tree.setChildrenMothers(selectedPerson.id, assignments)
                      showSaved(selectedPerson.id)
                    }}
                    onBack={() => setReviewFocus(isWivesPhase ? 'wives' : 'children')}
                  />
                ) : (
                  <ChildrenBatchForm
                    key={`children-${selectedPerson.id}`}
                    person={selectedPerson}
                    lineageText={lineageText}
                    isCurrent={!isEditingEarlier && isChildrenPhase}
                    canDelete={selectedPerson.id !== tree.root.id}
                    continueLabel={childrenContinueLabel}
                    returnToWivesLabel={isWivesPhase ? 'حفظ والعودة إلى الزوجات' : undefined}
                    onReturnToWives={isWivesPhase ? () => setReviewFocus('wives') : undefined}
                    onRename={(name) => tree.renamePerson(selectedPerson.id, name)}
                    onSave={(sons, daughters) => {
                      tree.setChildren(selectedPerson.id, sons, daughters)
                      showSaved(selectedPerson.id)
                    }}
                    onSaveAndContinue={(sons, daughters) => {
                      if (isWivesPhase) {
                        tree.setChildren(selectedPerson.id, sons, daughters)
                        showSaved(selectedPerson.id)
                        setReviewFocus('wives')
                      } else {
                        tree.setChildrenAndContinue(sons, daughters)
                        setSelectedId(null)
                      }
                    }}
                    onDelete={() => {
                      tree.deletePerson(selectedPerson.id)
                      setSelectedId(null)
                    }}
                    onReturnToCurrent={() => setSelectedId(null)}
                  />
                )}
              </>
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
            <p className="eyebrow">اكتمل إدخال الأشخاص والزوجات</p>
            <h2>أصبحت الشجرة جاهزة للمراجعة</h2>
            <p className="lede">
              سُجّل {arabicCount(counts.males, 'رجل', 'رجال')} و
              {arabicCount(counts.females, 'امرأة', 'نساء')}. اختر أي رجل من
              الشجرة لتعديل أبنائه أو زوجاته أو أمهاتهم.
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
                onClick={() => {
                  setReviewFocus('wives')
                  tree.startWivesPhase()
                  setSelectedId(null)
                }}
              >
                مراجعة الزوجات رجلاً برجُل
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
        <p className="tree-help">
          {isWivesPhase
            ? 'اختر أي رجل لمراجعة زوجاته أو تعديلها.'
            : isComplete
              ? 'اختر أي رجل لمراجعة أبنائه أو زوجاته أو أمهاتهم.'
              : 'اختر أي رجل لمراجعة أبنائه وبناته.'}
        </p>
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

      {isLinkModalOpen && (
        <LinkTreeModal
          isOpen={isLinkModalOpen}
          onClose={() => setIsLinkModalOpen(false)}
          mainTree={null}
          allTrees={sessions}
          targetBranchTreeId={treeId}
          onCreateLinkedTree={handleCreateLinkedTree}
          onLinkExistingTree={handleLinkExistingTree}
        />
      )}
    </div>
  )
}
