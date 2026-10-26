import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { LinkTreeModal } from './components/LinkTreeModal'
import { TreeApp } from './components/SteppedEditorPage'

const VisualTreeChart = lazy(() =>
  import('./components/VisualTreeChart').then((m) => ({ default: m.VisualTreeChart })),
)
const PrintableTributeView = lazy(() =>
  import('./components/PrintableTributeView').then((m) => ({ default: m.PrintableTributeView })),
)
import {
  EditorCodeModal,
  isEditorUnlocked,
  setEditorUnlocked,
  signOutEditor,
} from './components/EditorCodeModal'
import { supabase } from './lib/supabase'
import { EditorSessionError, reconcileEditorUnlock } from './lib/editorAuth'

import { useSessionList } from './hooks/useSessionList'
import { useSync } from './hooks/useSync'
import { useUnifiedTree } from './hooks/useUnifiedTree'
import {
  countPeople,
  cleanBranchOrTreeTitle,
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

function getUrlParams(): {
  treeId: string | null
  view: 'editor' | 'chart' | 'print' | 'stepped-editor'
  personId: string | null
  unified: boolean
} {
  const params = new URLSearchParams(window.location.search)
  const v = params.get('view')
  return {
    treeId: params.get('t') || params.get('tree'),
    personId: params.get('person'),
    unified: params.get('unified') === '1' || params.get('unified') === 'true',
    view:
      v === 'chart'
        ? 'chart'
        : v === 'print'
          ? 'print'
          : v === 'stepped-editor' || v === 'editor'
            ? 'stepped-editor'
            : 'editor',
  }
}

// Editor authentication is handled by ./components/EditorCodeModal.
// The passcode is verified by the `editor-login` Supabase Edge Function; only a
// short-lived Supabase Auth session (never the passcode) is kept in the client.

function RouteLoading() {
  return (
    <div style={{ minHeight: '40vh', display: 'grid', placeItems: 'center' }}>
      <span className="spin" style={{ fontSize: 28 }}>⏳</span>
    </div>
  )
}

export default function App() {
  const [route, setRoute] = useState(getUrlParams)

  useEffect(() => {
    const handler = () => setRoute(getUrlParams())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // Clear the local unlock flag if the real Supabase session is revoked.
  useEffect(() => {
    void reconcileEditorUnlock()

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) setEditorUnlocked(false)
    })

    return () => {
      data.subscription.unsubscribe()
    }
  }, [])

  function navigate(
    id: string | null,
    view: 'editor' | 'chart' | 'print' | 'stepped-editor' = 'editor',
    personId?: string | null,
    unified?: boolean
  ) {
    let url = window.location.pathname
    if (id) {
      url += `?t=${id}`
      if (view === 'chart') url += '&view=chart'
      else if (view === 'print') url += '&view=print'
      else if (view === 'stepped-editor') url += '&view=stepped-editor'
      if (personId) url += `&person=${personId}`
      if (unified) url += '&unified=1'
    }
    history.pushState({}, '', url)
    setRoute({
      treeId: id,
      view: id ? view : 'editor',
      personId: personId || null,
      unified: !!unified,
    })
  }

  if (!route.treeId) {
    return (
      <HomeScreen
        onNavigate={(id) => navigate(id, 'chart')}
        onView={(id) => navigate(id, 'chart')}
        onEdit={(id) => navigate(id, 'stepped-editor')}
      />
    )
  }

  if (route.view === 'stepped-editor') {
    return (
      <SteppedEditorPage
        key={route.treeId}
        treeId={route.treeId}
        onGoToChart={() => navigate(route.treeId, 'chart')}
        onGoToPrint={() => navigate(route.treeId, 'print')}
        onOpenTree={(id) => navigate(id, 'chart')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  if (route.view === 'print') {
    return (
      <TreePrintPage
        treeId={route.treeId}
        isUnified={route.unified}
        onGoBack={() => navigate(route.treeId, 'chart')}
        onGoToChart={() => navigate(route.treeId, 'chart')}
        onOpenTree={(id) => navigate(id, 'print')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  // The chart is the main app. It is read-only until the editor is unlocked.
  return (
    <TreeChartPage
      key={route.treeId}
      treeId={route.treeId}
      initialPersonId={route.personId}
      onGoToEditor={() => navigate(route.treeId, 'stepped-editor')}
      onGoToPrint={(unified) => navigate(route.treeId, 'print', null, unified)}
      onGoHome={() => navigate(null)}
      onOpenTree={(id, personId) => navigate(id, 'chart', personId)}
    />
  )
}

const OLD_STORAGE_KEY = 'nasab-tree-state-v1'

function HomeScreen({
  onNavigate,
  onView,
  onEdit,
}: {
  onNavigate: (id: string) => void
  onView: (id: string) => void
  onEdit: (id: string) => void
}) {
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

  // Editor passcode modal state
  const [isCodeModalOpen, setIsCodeModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [isUnlocked, setIsUnlocked] = useState(isEditorUnlocked)

  // Search filter
  const [searchQuery, setSearchQuery] = useState('')

  // Collapsible branch toggle map (collapsed by default)
  const [expandedBranches, setExpandedBranches] = useState<Record<string, boolean>>({})

  // Card options menu state
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null)

  useEffect(() => {
    function handleClickOutside() {
      setActiveMenuId(null)
    }
    if (activeMenuId) {
      window.addEventListener('click', handleClickOutside)
      return () => window.removeEventListener('click', handleClickOutside)
    }
  }, [activeMenuId])

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

  async function requireEditorAccess(action: () => void) {
    if (isEditorUnlocked()) {
      // The sessionStorage flag can outlive the real session; verify before
      // running the action so we never send an unauthenticated write.
      const stillValid = await reconcileEditorUnlock()
      if (stillValid) {
        setIsUnlocked(true)
        action()
        return
      }
      setIsUnlocked(false)
    }
    setPendingAction(() => action)
    setIsCodeModalOpen(true)
  }

  function handleLockEditor() {
    void signOutEditor()
    setIsUnlocked(false)
  }

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
    try {
      await deleteSession(id)
      setDeleteConfirm(null)
    } catch (err) {
      console.error('Failed to delete tree:', err)
      if (err instanceof EditorSessionError) {
        // The editor session expired: lock the UI, ask for the PIN, then retry.
        setEditorUnlocked(false)
        setIsUnlocked(false)
        setDeleteConfirm(null)
        setPendingAction(() => () => void handleDelete(id))
        setIsCodeModalOpen(true)
        return
      }
      alert(`تعذر حذف الشجرة: ${err instanceof Error ? err.message : 'خطأ غير معروف'}`)
    }
  }

  function toggleBranches(sessionId: string) {
    setExpandedBranches((prev) => ({
      ...prev,
      [sessionId]: !prev[sessionId],
    }))
  }

  const mainTrees = useMemo(() => sessions.filter((s) => !s.linkedFrom), [sessions])
  const linkedTrees = useMemo(() => sessions.filter((s) => !!s.linkedFrom), [sessions])
  const mainTreeIds = useMemo(() => new Set(mainTrees.map((m) => m.id)), [mainTrees])
  const orphanLinkedTrees = useMemo(
    () => linkedTrees.filter((b) => !mainTreeIds.has(b.linkedFrom!.mainTreeId)),
    [linkedTrees, mainTreeIds]
  )

  // Filtered by search query if any
  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filteredMainTrees = useMemo(() => {
    if (!normalizedQuery) return mainTrees
    return mainTrees.filter((t) => {
      const matchName = t.name.toLowerCase().includes(normalizedQuery)
      const matchAncestor = t.rootAncestor?.toLowerCase().includes(normalizedQuery)
      const matchBranch = linkedTrees.some(
        (b) =>
          b.linkedFrom?.mainTreeId === t.id &&
          (b.name.toLowerCase().includes(normalizedQuery) ||
            b.linkedFrom?.personName?.toLowerCase().includes(normalizedQuery))
      )
      return matchName || matchAncestor || matchBranch
    })
  }, [mainTrees, linkedTrees, normalizedQuery])

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
      {/* ── Top Header Bar ── */}
      <header className="home-header">
        <div className="brand" onClick={() => setSearchQuery('')} title="نَسَب">
          <span className="brand-mark">ن</span>
          <div className="brand-text-col">
            <span className="brand-title">نَسَب</span>
            <span className="brand-subtitle">شجرة القبيلة والنسب</span>
          </div>
        </div>

        <div className="home-header-actions">
          {/* Subtle connectivity dot */}
          {isSyncing ? (
            <span className="sync-status-dot syncing" title="جارٍ المزامنة السحابية…">
              <span className="spin">⟳</span>
            </span>
          ) : isOffline ? (
            <span className="sync-status-dot offline" title="الوضع المحلي بدون إنترنت">
              ⚡
            </span>
          ) : (
            <button
              type="button"
              className="sync-status-dot online"
              onClick={() => void syncNow()}
              title="متصل بالسحابة (انقر للتحديث)"
            >
              ●
            </button>
          )}

          {/* Small corner edit button with passcode modal trigger */}
          {isUnlocked ? (
            <div className="home-unlocked-actions">
              <button
                type="button"
                id="btn-create-tree"
                className="home-btn-create-header"
                onClick={() => void requireEditorAccess(() => void handleCreate())}
                disabled={creating}
                title="إنشاء سجل رئيسي جديد"
              >
                <span>＋</span>
                <span>{creating ? 'جارٍ الإنشاء…' : 'شجرة جديدة'}</span>
              </button>
              <button
                type="button"
                className="home-auth-corner-btn unlocked"
                onClick={handleLockEditor}
                title="وضع التعديل مفعل — انقر للقفل"
              >
                <span>🔓 وضع التحرير</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="home-auth-corner-btn locked"
              onClick={() => requireEditorAccess(() => {})}
              title="دخول المحرر وتعديل السجلات (رمز المرور)"
            >
              <span className="lock-icon">🔒</span>
              <span>تعديل</span>
            </button>
          )}
        </div>
      </header>

      {/* ── Main Container ── */}
      <div className="home-content">
        {/* Offline notice banner */}
        {isOffline && (
          <div className="offline-banner" role="alert">
            <span className="offline-banner-icon">⚡</span>
            <div className="offline-banner-text">
              <strong>أنت غير متصل بالإنترنت</strong> — تظهر الجلسات المحمّلة محلياً.
            </div>
          </div>
        )}

        {/* Migration banner if old local data exists */}
        {migratingState && (
          <div className="migration-banner">
            <div>
              <p className="migration-title">وُجد سجل سابق محلّي</p>
              <p className="migration-sub">
                شجرة «{migratingState.root?.name}» موجودة على هذا الجهاز فقط — انقلها إلى السحابة.
              </p>
            </div>
            <button
              className="primary"
              onClick={() => requireEditorAccess(() => void handleMigrate())}
              disabled={migrating}
            >
              {migrating ? 'جارٍ النقل…' : 'نقل إلى السحابة'}
            </button>
          </div>
        )}

        {/* ── Minimalist, Elegant Header & Search ── */}
        <section className="home-intro-clean">
          <h1 className="home-page-title">السجلات العائلية</h1>
          <p className="home-page-sub">
            سجل أنساب وذرية العائلة — اختر سجلاً لاستعراضه
          </p>

          {sessions.length > 0 && (
            <div className="home-search-pill-wrap">
              <span className="home-search-ico">🔍</span>
              <input
                type="text"
                className="home-search-pill-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ابحث بالاسم، الجد، أو الفرع..."
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="home-search-pill-clear"
                  onClick={() => setSearchQuery('')}
                  aria-label="مسح البحث"
                >
                  ✕
                </button>
              ) : (
                <span className="home-search-pill-count">
                  {sessions.length} {sessions.length === 1 ? 'سجل' : 'سجلات'}
                </span>
              )}
            </div>
          )}
        </section>

        {/* ── Tree Cards Grid ── */}
        {loading ? (
          <div className="home-empty-card">
            <div className="spin" style={{ fontSize: '28px', marginBottom: '12px' }}>⟳</div>
            <p>جارٍ تحميل السجلات العائلية…</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="home-empty-card">
            <div className="home-empty-icon">🌳</div>
            <p className="home-empty-title">لا توجد أشجار عائلية بعد</p>
            <p className="home-empty-sub">
              ابدأ بإنشاء أول شجرة لتوثيق أنساب العائلة.
            </p>
            <button
              className="primary home-empty-create-btn"
              onClick={() => requireEditorAccess(() => void handleCreate())}
            >
              ＋ إنشاء أول شجرة عائلية
            </button>
          </div>
        ) : filteredMainTrees.length === 0 && searchQuery ? (
          <div className="home-empty-card">
            <p className="home-empty-title">لا توجد نتائج تطابق «{searchQuery}»</p>
            <p className="home-empty-sub">جرّب البحث باسم آخر أو امسح حقل البحث.</p>
            <button
              type="button"
              className="compact-button"
              style={{ marginTop: '10px' }}
              onClick={() => setSearchQuery('')}
            >
              عرض جميع الأشجار
            </button>
          </div>
        ) : (
          <div className="tree-cards-list">
            {filteredMainTrees.map((session) => {
              const isDownloaded = session.downloaded === true
              const isDownloading = downloadingId === session.id
              const branches = linkedTrees.filter((b) => b.linkedFrom?.mainTreeId === session.id)
              const isBranchesExpanded = !!expandedBranches[session.id]
              const isMenuOpen = activeMenuId === session.id

              return (
                <article
                  key={session.id}
                  className="tree-card"
                  onClick={() => onView(session.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onView(session.id)
                    }
                  }}
                >
                  <div className="tree-card-top">
                    <div className="tree-card-emblem-wrap">
                      <span className="tree-card-emblem">🌳</span>
                    </div>

                    <div className="tree-card-title-col">
                      <h2 className="tree-card-name">{session.name}</h2>
                      {session.rootAncestor && session.rootAncestor !== session.name && (
                        <span className="tree-root-tag" title="الجد الأساسي">
                          الأصل: {session.rootAncestor}
                        </span>
                      )}
                    </div>

                    {/* Options menu — only visible in Editor Mode to keep reading clean and uncluttered */}
                    {isUnlocked && (
                      <div className="tree-card-menu-anchor" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="tree-card-dots-btn"
                          onClick={() => setActiveMenuId(isMenuOpen ? null : session.id)}
                          title="خيارات الإدارة"
                          aria-label="خيارات إضافية"
                        >
                          ⋯
                        </button>

                        {isMenuOpen && (
                          <div className="tree-card-dropdown" onClick={(e) => e.stopPropagation()}>
                            {!isOffline && !isDownloaded && (
                              <button
                                type="button"
                                className="dropdown-item"
                                onClick={() => {
                                  setActiveMenuId(null)
                                  void downloadSession(session.id)
                                }}
                                disabled={isDownloading}
                              >
                                ⬇ حفظ للعمل بدون إنترنت
                              </button>
                            )}
                            <button
                              type="button"
                              className="dropdown-item"
                              onClick={() => {
                                setActiveMenuId(null)
                                onEdit(session.id)
                              }}
                            >
                              📝 صفحة الإدخال
                            </button>
                            <button
                              type="button"
                              className="dropdown-item"
                              onClick={() => {
                                setActiveMenuId(null)
                                requireEditorAccess(() => openLinkModal(session))
                              }}
                            >
                              🔗 إضافة فرع مرتبط
                            </button>
                            <button
                              type="button"
                              className="dropdown-item danger"
                              onClick={() => {
                                setActiveMenuId(null)
                                requireEditorAccess(() => setDeleteConfirm(session.id))
                              }}
                            >
                              🗑️ حذف الشجرة
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Inline delete confirmation */}
                  {deleteConfirm === session.id && (
                    <div
                      className="tree-card-delete-alert"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <p>هل تريد بالتأكيد حذف «{session.name}»؟</p>
                      <div className="tree-card-delete-btns">
                        <button
                          type="button"
                          className="tree-danger-confirm-btn"
                          onClick={() => void handleDelete(session.id)}
                        >
                          تأكيد الحذف
                        </button>
                        <button
                          type="button"
                          className="tree-sub-btn"
                          onClick={() => setDeleteConfirm(null)}
                        >
                          إلغاء
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Meta row */}
                  <div className="tree-card-meta-line">
                    <span className="tree-card-date">
                      🕒 {formatDate(session.updated_at)}
                    </span>

                    {isDownloaded ? (
                      <span className="tree-status-badge downloaded" title="متاح للعمل بدون إنترنت">
                        ✓ محلي
                      </span>
                    ) : (
                      <span className="tree-status-badge cloud" title="موجود على السحابة">
                        ☁ سحابي
                      </span>
                    )}

                    {branches.length > 0 && (
                      <button
                        type="button"
                        className="tree-branches-counter-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleBranches(session.id)
                        }}
                        title="إظهار / إخفاء الأفرع المرتبطة"
                      >
                        🌿 {branches.length} {branches.length === 1 ? 'فرع مرتبط' : 'أفرع'}{' '}
                        <span className="toggle-chevron">{isBranchesExpanded ? '▲' : '▼'}</span>
                      </button>
                    )}
                  </div>

                  {/* Nested branches list if expanded */}
                  {branches.length > 0 && isBranchesExpanded && (
                    <div className="tree-branches-section" onClick={(e) => e.stopPropagation()}>
                      <div className="tree-branches-cards">
                        {branches.map((branch) => {
                          const l = branch.linkedFrom!
                          return (
                            <div
                              key={branch.id}
                              className="tree-branch-chip-btn"
                              onClick={() => onView(branch.id)}
                              title="انقر لفتح هذا الفرع"
                              role="button"
                              tabIndex={0}
                            >
                              <span className={`link-badge-pill ${l.type}`}>
                                {l.type === 'daughter-branch'
                                  ? '🧬 فرع بنت'
                                  : l.type === 'brother-branch'
                                  ? '🤝 فرع أخ الجد'
                                  : '🌿 فرع مرتبط'}
                              </span>
                              <span className="tree-branch-chip-name">{branch.name}</span>
                              <span className="tree-branch-chip-arrow">←</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Clean bottom affordance */}
                  <div className="tree-card-footer">
                    <span className="tree-card-view-link">
                      استعراض السجل
                      <span className="tree-card-view-arrow">←</span>
                    </span>
                  </div>
                </article>
              )
            })}

            {/* Standalone / Orphaned linked trees if any */}
            {orphanLinkedTrees.length > 0 && (
              <div className="orphan-branches-block">
                <h3 className="orphan-branches-title">أفرع وشجرات مرتبطة أخرى</h3>
                <div className="tree-cards-list">
                  {orphanLinkedTrees.map((branch) => {
                    const l = branch.linkedFrom!
                    const isDownloaded = branch.downloaded === true

                    return (
                      <article
                        key={branch.id}
                        className="tree-card orphan-tree-card"
                        onClick={() => onView(branch.id)}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="tree-card-top">
                          <div className="tree-card-emblem-wrap">
                            <span className="tree-card-emblem">🌿</span>
                          </div>
                          <div className="tree-card-title-col">
                            <div className="tree-card-title-line">
                              <span className={`link-badge-pill ${l.type}`}>
                                {l.type === 'daughter-branch'
                                  ? '🧬 فرع بنت'
                                  : l.type === 'brother-branch'
                                  ? '🤝 فرع أخ الجد'
                                  : '🌿 فرع مرتبط'}
                              </span>
                              <h2 className="tree-card-name">{branch.name}</h2>
                              <span className="tree-root-tag">الأصل: {l.mainTreeName}</span>
                            </div>
                          </div>
                        </div>

                        <div className="tree-card-meta-line">
                          <span className="tree-card-date">🕒 {formatDate(branch.updated_at)}</span>
                          {isDownloaded ? (
                            <span className="tree-status-badge downloaded">✓ محلي</span>
                          ) : (
                            <span className="tree-status-badge cloud">☁ سحابي</span>
                          )}
                        </div>

                        <div className="tree-card-footer">
                          <span className="tree-card-view-link">
                            استعراض الفرع
                            <span className="tree-card-view-arrow">←</span>
                          </span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <footer className="home-footer-hint">
          {isOffline
            ? '💡 يمكنك استعراض وتعديل الجلسات المحملة بالكامل بدون إنترنت، وستُرفع تلقائياً فور اتصالك.'
            : '💡 السجلات متاحة للجميع للاستعراض والقراءة، بينما التعديل محمي برمز مرور العائلة.'}
        </footer>
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

      {/* Editor Code Modal */}
      <EditorCodeModal
        isOpen={isCodeModalOpen}
        onClose={() => {
          setIsCodeModalOpen(false)
          setPendingAction(null)
        }}
        onSuccess={() => {
          setIsUnlocked(true)
          if (pendingAction) {
            const action = pendingAction
            setPendingAction(null)
            action()
          }
        }}
      />
    </main>
  )
}

// ── Stepped editor page (the original data-entry interface) ──────────────────

function SteppedEditorPage({
  treeId,
  onGoToChart,
  onGoToPrint,
  onOpenTree,
  onGoHome,
}: {
  treeId: string
  onGoToChart: () => void
  onGoToPrint: () => void
  onOpenTree: (id: string) => void
  onGoHome: () => void
}) {
  const [isUnlocked, setIsUnlocked] = useState(isEditorUnlocked)
  const [isGateOpen, setIsGateOpen] = useState(!isEditorUnlocked())

  useEffect(() => {
    let active = true
    void (async () => {
      const ok = await reconcileEditorUnlock()
      if (!active) return
      const unlocked = ok && isEditorUnlocked()
      setIsUnlocked(unlocked)
      setIsGateOpen(!unlocked)
    })()
    return () => {
      active = false
    }
  }, [])

  if (isUnlocked) {
    return (
      <TreeApp
        treeId={treeId}
        onOpenChart={onGoToChart}
        onOpenPrint={onGoToPrint}
        onOpenTree={onOpenTree}
        onGoHome={onGoHome}
      />
    )
  }

  return (
    <main className="editor-gate-screen" dir="rtl">
      <div className="setup-card" style={{ maxWidth: 540 }}>
        <p className="eyebrow">نَسَب · صفحة الإدخال</p>
        <h1>صفحة الإدخال محمية</h1>
        <p className="lede">
          صفحة الإدخال تُستخدم لإضافة الأبناء والزوجات والأمهات خطوة بخطوة. أدخل
          رمز العائلة لفتحها، أو ارجع إلى المخطط للاستعراض فقط.
        </p>
        <div className="actions" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="primary"
            onClick={() => setIsGateOpen(true)}
          >
            🔒 إدخال رمز المرور
          </button>
          <button type="button" className="compact-button" onClick={onGoToChart}>
            ← العودة إلى المخطط
          </button>
        </div>
      </div>
      <EditorCodeModal
        isOpen={isGateOpen}
        onClose={() => setIsGateOpen(false)}
        onSuccess={() => {
          setIsUnlocked(true)
          setIsGateOpen(false)
        }}
      />
    </main>
  )
}

// ── Tree Chart Page (full screen visual diagram) ──────────────────────────────

function TreeChartPage({
  treeId,
  initialPersonId,
  onGoToEditor,
  onGoToPrint,
  onGoHome,
  onOpenTree,
}: {
  treeId: string
  initialPersonId?: string | null
  onGoToEditor: () => void
  onGoToPrint: (isUnified?: boolean) => void
  onGoHome: () => void
  onOpenTree?: (id: string, personId?: string) => void
}) {
  const tree = useTreeBuilder(treeId)
  const { sessions, refresh } = useSessionList()
  const [selectedId, setSelectedId] = useState<string | null>(() => initialPersonId || null)
  const [newRootName, setNewRootName] = useState('')

  const [showUnifiedView, setShowUnifiedView] = useState(true)
  const [commonFatherName] = useState(() => {
    const stored = localStorage.getItem(`commonFatherName_${treeId}`)
    return stored?.trim() || (tree as any).commonFatherName?.trim() || 'محمد'
  })
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [linkModalPerson, setLinkModalPerson] = useState<Person | null>(null)
  const [linkModalTargetBranchId, setLinkModalTargetBranchId] = useState<string | null>(null)

  // Passcode-protection for edit actions (verified server-side)
  const [isUnlocked, setIsUnlocked] = useState(isEditorUnlocked)
  const [isCodeModalOpen, setIsCodeModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  async function requireEditorAccess(action: () => void) {
    if (isEditorUnlocked()) {
      // The sessionStorage flag can outlive the real session; verify before
      // running the action so we never send an unauthenticated write.
      const stillValid = await reconcileEditorUnlock()
      if (stillValid) {
        setIsUnlocked(true)
        action()
        return
      }
      setIsUnlocked(false)
    }
    setPendingAction(() => action)
    setIsCodeModalOpen(true)
  }

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
    commonFatherName: commonFatherName.trim() || undefined,
  })

  const displayRoot = showUnifiedView && unifiedResult ? unifiedResult.root : tree.root

  if (!tree.root) {
    if (tree.isSyncing) {
      return (
        <main className="setup" dir="rtl">
          <div className="setup-card">
            <p className="eyebrow">نَسَب</p>
            <h1>جارٍ تحميل مخطط الشجرة…</h1>
            <div className="spin" style={{ fontSize: '28px', marginTop: '16px' }}>⟳</div>
          </div>
        </main>
      )
    }

    return (
      <main className="setup" dir="rtl">
        <div className="setup-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🌳</div>
          <p className="eyebrow">سجل فارغ</p>
          <h1 style={{ fontSize: '26px', marginBottom: '8px' }}>لم يتم إدخال بيانات هذا السجل بعد</h1>
          <p className="lede" style={{ margin: '0 auto 20px', maxWidth: '40ch' }}>
            هذا السجل جديد ولا يحتوي على جد أساسي أو أفراد. ابدأ بإضافة الجد الأعلى ثم أضف الأبناء والزوجات من المخطط.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
            {isUnlocked ? (
              <>
                <input
                  value={newRootName}
                  onChange={(e) => setNewRootName(e.target.value)}
                  placeholder="اسم الجد الأعلى"
                  style={{
                    padding: '9px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                  }}
                />
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    if (!newRootName.trim()) return
                    tree.startRoot(newRootName)
                    setNewRootName('')
                  }}
                >
                  بدء الشجرة
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => requireEditorAccess(() => {})}
              >
                🔒 فتح المحرر للبدء
              </button>
            )}
            <button
              type="button"
              className="compact-button"
              onClick={onGoHome}
            >
              ← العودة للرئيسية
            </button>
          </div>
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

        {/* Editing stays locked until the family PIN is verified. Keep the
            entry point here too, so users do not have to go back to Home. */}
        {isUnlocked ? (
          <button
            type="button"
            className="compact-button editor-auth-badge unlocked"
            onClick={() => {
              void signOutEditor()
              setIsUnlocked(false)
            }}
            title="وضع التعديل مفعل — انقر للقفل"
          >
            🔓 وضع التعديل (قفل)
          </button>
        ) : (
          <button
            type="button"
            className="compact-button editor-auth-badge locked"
            onClick={() => requireEditorAccess(() => {})}
            title="فتح وضع التعديل برمز العائلة"
          >
            🔒 وضع التحرير
          </button>
        )}

        <button
          type="button"
          className="compact-button"
          onClick={onGoToEditor}
          title="فتح صفحة الإدخال خطوة بخطوة (أبناء، زوجات، أمهات)"
        >
          📝 صفحة الإدخال
        </button>

        <button
          type="button"
          className="compact-button"
          onClick={() => onGoToPrint(showUnifiedView)}
          title="عرض وطباعة وثيقة وسجل النسب"
        >
          🖨️ {showUnifiedView && hasConnectedBranches ? 'طباعة السجل الموحد' : 'وثيقة للطباعة'}
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
            <button
              type="button"
              className="linked-tree-nav-btn"
              onClick={() => {
                if (onOpenTree && currentTreeMeta.linkedFrom) {
                  onOpenTree(currentTreeMeta.linkedFrom.mainTreeId, currentTreeMeta.linkedFrom.personId)
                }
              }}
              title={`الانتقال إلى السجل الرئيسي الكامل «${currentTreeMeta.linkedFrom.mainTreeName}»`}
            >
              <span className="badge-icon">
                {currentTreeMeta.linkedFrom.type === 'daughter-branch' ? '🧬' : '🤝'}
              </span>
              <span>
                متصلة بـ «{currentTreeMeta.linkedFrom.mainTreeName}»
                {currentTreeMeta.linkedFrom.personName ? ` (أم/صلة: ${currentTreeMeta.linkedFrom.personName})` : ''}
              </span>
              <span className="linked-tree-nav-arrow">← فتح السجل الكامل</span>
            </button>
            {isUnlocked && (
              <button
                type="button"
                className="unlink-mini-btn"
                onClick={() => requireEditorAccess(() => void handleLinkExistingTree(treeId, null))}
                title="فك الارتباط لتصبح هذه الشجرة مستقلة ومنفصلة تماماً"
              >
                ✂️ فك الارتباط
              </button>
            )}
          </div>
        ) : isUnlocked ? (
          <button
            type="button"
            className="compact-button"
            onClick={() => {
              requireEditorAccess(() => {
                setLinkModalTargetBranchId(treeId)
                setLinkModalPerson(null)
                setIsLinkModalOpen(true)
              })
            }}
            title="ربط هذه الشجرة كفرع لشجرة أخرى (مثال: أخت الجد الخامس هي أم لهذه الشجرة)"
          >
            🔗 ربط هذه الشجرة كفرع بشجرة أخرى
          </button>
        ) : null}

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
        <Suspense fallback={<RouteLoading />}>
          <VisualTreeChart
            root={displayRoot}
          isUnifiedView={showUnifiedView && !!unifiedResult?.isUnified}
          isEditMode={isUnlocked && !tree.isSyncing}
          currentTreeId={treeId}
          currentTreeName={mainTreeName}
          availableTrees={sessions}
          selectedId={selectedId}
          currentId={tree.currentPersonId}
          onSelectPerson={(person) => setSelectedId(person.id)}
          onRenamePerson={(personId, name) =>
            requireEditorAccess(() => tree.renamePerson(personId, name))
          }
          onAddChildrenBatch={(personId, sons, daughters) =>
            requireEditorAccess(() => tree.setChildren(personId, sons, daughters))
          }
          onDeletePerson={(personId) =>
            requireEditorAccess(() => tree.deletePerson(personId))
          }
          onAddWife={(personId, wifeNameOrId) =>
            requireEditorAccess(() => tree.addWifeToPerson(personId, wifeNameOrId))
          }
          onRemoveWife={(personId, index) =>
            requireEditorAccess(() => tree.removeWifeFromPerson(personId, index))
          }
          onLinkBranchForPerson={(person) => {
            requireEditorAccess(() => {
              setLinkModalPerson(person)
              setLinkModalTargetBranchId(null)
              setIsLinkModalOpen(true)
            })
          }}
          onOpenTree={onOpenTree}
          />
        </Suspense>
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

      {/* Editor Code Modal (server-verified passcode) */}
      <EditorCodeModal
        isOpen={isCodeModalOpen}
        onClose={() => {
          setIsCodeModalOpen(false)
          setPendingAction(null)
        }}
        onSuccess={() => {
          setIsUnlocked(true)
          if (pendingAction) {
            const action = pendingAction
            setPendingAction(null)
            action()
          }
        }}
      />
    </div>
  )
}

// ── Tree Print Page (archival printable tribute & chart) ──────────────────────

function TreePrintPage({
  treeId,
  isUnified: initialUnified,
  onGoBack,
  onGoToChart,
  onOpenTree,
  onGoHome,
}: {
  treeId: string
  isUnified?: boolean
  onGoBack: () => void
  onGoToChart: () => void
  onOpenTree?: (treeId: string) => void
  onGoHome: () => void
}) {
  const tree = useTreeBuilder(treeId)
  const { sessions } = useSessionList()
  const currentTreeMeta = useMemo(() => sessions.find((s) => s.id === treeId) || null, [sessions, treeId])
  const mainTreeName = currentTreeMeta?.name || tree.root?.name || 'الشجرة العائلية'

  const commonFatherName = useMemo(() => {
    return localStorage.getItem(`commonFatherName_${treeId}`)?.trim() || (tree as any).commonFatherName?.trim() || 'محمد'
  }, [treeId, (tree as any).commonFatherName])

  const { unifiedResult, hasConnectedBranches, branchCount } = useUnifiedTree({
    mainTreeId: treeId,
    mainRoot: tree.root ?? null,
    mainTreeName,
    sessions,
    enabled: true,
    commonFatherName,
  })

  const [printUnified, setPrintUnified] = useState(initialUnified ?? true)

  useEffect(() => {
    if (initialUnified !== undefined) {
      setPrintUnified(initialUnified)
    } else if (hasConnectedBranches) {
      setPrintUnified(true)
    }
  }, [initialUnified, hasConnectedBranches])

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

  if (hasConnectedBranches && printUnified && !unifiedResult) {
    return (
      <main className="setup" dir="rtl">
        <div className="setup-card" style={{ textAlign: 'center' }}>
          <p className="eyebrow">نَسَب</p>
          <h1>جارٍ دمج الأفرع المرتبطة بالسجل…</h1>
          <div className="spin" style={{ fontSize: '28px', marginTop: '16px' }}>⟳</div>
        </div>
      </main>
    )
  }

  const effectiveRoot = (printUnified && unifiedResult?.root) ? unifiedResult.root : tree.root
  const cleanMainName = cleanBranchOrTreeTitle(mainTreeName)
  const cleanRootName = cleanBranchOrTreeTitle(tree.root.name)
  const effectiveTitle = printUnified && unifiedResult?.root
    ? `السجل الموحد لنسب آل ${cleanMainName}`
    : `سجل نسب آل ${cleanRootName}`

  return (
    <Suspense fallback={<RouteLoading />}>
      <PrintableTributeView
        root={effectiveRoot}
        treeName={effectiveTitle}
        linkedFrom={tree.linkedFrom}
        linkedTrees={printUnified ? undefined : linkedTrees}
        isUnified={printUnified}
        branchCount={branchCount}
        onToggleUnified={hasConnectedBranches ? () => setPrintUnified((prev) => !prev) : undefined}
        onGoBack={onGoBack}
        onGoToChart={onGoToChart}
        onOpenTree={onOpenTree}
      />
    </Suspense>
  )
}
