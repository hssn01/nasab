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

function getUrlParams(): { treeId: string | null; view: 'editor' | 'chart' | 'print' | 'viewer' | 'stepped-editor' } {
  const params = new URLSearchParams(window.location.search)
  const v = params.get('view')
  return {
    treeId: params.get('t'),
    view:
      v === 'viewer'
        ? 'viewer'
        : v === 'chart'
        ? 'chart'
        : v === 'print'
        ? 'print'
        : v === 'stepped-editor'
        ? 'stepped-editor'
        : 'editor',
  }
}

const EDITOR_PASSCODE = '2233'
const STORAGE_ACCESS_KEY = 'nasab_editor_unlocked'

function isEditorUnlocked(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_ACCESS_KEY) === 'true'
  } catch {
    return false
  }
}

function setEditorUnlocked(unlocked: boolean) {
  try {
    if (unlocked) {
      sessionStorage.setItem(STORAGE_ACCESS_KEY, 'true')
    } else {
      sessionStorage.removeItem(STORAGE_ACCESS_KEY)
    }
  } catch {}
}

// ── Editor Code Modal ─────────────────────────────────────────────────────────

function EditorCodeModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setCode('')
      setError(false)
      const t = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(t)
    }
  }, [isOpen])

  if (!isOpen) return null

  function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault()
    if (code.trim() === EDITOR_PASSCODE) {
      setEditorUnlocked(true)
      setError(false)
      onSuccess()
      onClose()
    } else {
      setError(true)
      setCode('')
      inputRef.current?.focus()
    }
  }

  return (
    <div className="editor-modal-backdrop" onClick={onClose} dir="rtl">
      <div className="editor-modal-card" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="editor-modal-close"
          onClick={onClose}
          aria-label="إغلاق"
        >
          ✕
        </button>

        <div className="editor-modal-icon-badge">
          <span>🔒</span>
        </div>

        <h3 className="editor-modal-title">رمز الدخول للمحرر</h3>
        <p className="editor-modal-sub">
          أدخل رمز المرور للتمكن من تعديل وحفظ بيانات المشجر العائلي
        </p>

        <form onSubmit={handleSubmit} className="editor-modal-form">
          <div className="editor-code-input-wrap">
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              placeholder="••••"
              value={code}
              onChange={(e) => {
                setError(false)
                setCode(e.target.value)
              }}
              className={`editor-code-input ${error ? 'code-input-error' : ''}`}
              autoComplete="off"
            />
          </div>

          {error && (
            <div className="editor-modal-error-alert" role="alert">
              <span>⚠️ الرمز غير صحيح، يرجى المحاولة مرة أخرى</span>
            </div>
          )}

          <div className="editor-modal-actions">
            <button type="submit" className="primary editor-modal-submit-btn">
              تأكيد والدخول للمحرر
            </button>
            <button
              type="button"
              className="compact-button editor-modal-cancel-btn"
              onClick={onClose}
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Editor Gate Screen (direct URL access without PIN) ────────────────────────

function EditorGateScreen({
  onUnlocked,
  onGoToViewer,
  onGoHome,
}: {
  onUnlocked: () => void
  onGoToViewer: () => void
  onGoHome: () => void
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (code.trim() === EDITOR_PASSCODE) {
      setEditorUnlocked(true)
      onUnlocked()
    } else {
      setError(true)
      setCode('')
      inputRef.current?.focus()
    }
  }

  return (
    <main className="editor-gate-screen" dir="rtl">
      <div className="editor-gate-card">
        <div className="editor-modal-icon-badge">
          <span>🔒</span>
        </div>
        <p className="eyebrow">نَسَب · بوابة المحرر</p>
        <h1 className="editor-gate-title">محرر المشجر محمي برمز مرور</h1>
        <p className="editor-gate-desc">
          لتعديل بيانات الشجرة وإضافة الأفراد، يرجى إدخال رمز الدخول.
          إذا كنت ترغب فقط في استعراض الشجرة وقراءتها فلا حاجة لرمز.
        </p>

        <form onSubmit={handleSubmit} className="editor-modal-form">
          <div className="editor-code-input-wrap">
            <input
              ref={inputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={10}
              placeholder="••••"
              value={code}
              onChange={(e) => {
                setError(false)
                setCode(e.target.value)
              }}
              className={`editor-code-input ${error ? 'code-input-error' : ''}`}
              autoComplete="off"
            />
          </div>

          {error && (
            <div className="editor-modal-error-alert" role="alert">
              <span>⚠️ الرمز غير صحيح، يرجى المحاولة مرة أخرى</span>
            </div>
          )}

          <div className="editor-gate-btns">
            <button type="submit" className="primary editor-modal-submit-btn">
              فتح المحرر
            </button>
            <button
              type="button"
              className="compact-button editor-gate-viewer-btn"
              onClick={onGoToViewer}
            >
              👁️ عرض الشجرة للقراءة فقط (بدون رمز)
            </button>
            <button
              type="button"
              className="compact-button"
              onClick={onGoHome}
            >
              ← العودة للقائمة الرئيسية
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}

// ── App root — handles URL routing ───────────────────────────────────────────

export default function App() {
  const [route, setRoute] = useState(getUrlParams)
  const [isUnlocked, setIsUnlocked] = useState(isEditorUnlocked)

  useEffect(() => {
    const handler = () => {
      setRoute(getUrlParams())
      setIsUnlocked(isEditorUnlocked())
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  function navigate(id: string | null, view: 'editor' | 'chart' | 'print' | 'viewer' | 'stepped-editor' = 'editor') {
    let url = window.location.pathname
    if (id) {
      url += `?t=${id}`
      if (view === 'chart') url += `&view=chart`
      else if (view === 'print') url += `&view=print`
      else if (view === 'viewer') url += `&view=viewer`
      else if (view === 'stepped-editor') url += `&view=stepped-editor`
    } else if (view === 'viewer') {
      url += `?view=viewer`
    }
    history.pushState({}, '', url)
    setRoute({ treeId: id, view: id ? view : (view === 'viewer' ? 'viewer' : 'editor') })
  }

  if (route.view === 'viewer' && !route.treeId) {
    return <PublicViewerPortal initialTreeId={undefined} onGoHome={() => navigate(null)} />
  }

  if (!route.treeId) {
    return (
      <HomeScreen
        onNavigate={(id) => navigate(id, 'chart')}
        onView={(id) => navigate(id, 'chart')}
      />
    )
  }

  if (route.view === 'print') {
    return (
      <TreePrintPage
        treeId={route.treeId}
        onGoToEditor={() => navigate(route.treeId, 'chart')}
        onGoToChart={() => navigate(route.treeId, 'chart')}
        onOpenTree={(id) => navigate(id, 'print')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  if (route.view === 'stepped-editor') {
    if (!isUnlocked) {
      return (
        <EditorGateScreen
          onUnlocked={() => setIsUnlocked(true)}
          onGoToViewer={() => navigate(route.treeId, 'chart')}
          onGoHome={() => navigate(null)}
        />
      )
    }
    return (
      <TreeApp
        treeId={route.treeId}
        onOpenChart={() => navigate(route.treeId, 'chart')}
        onOpenPrint={() => navigate(route.treeId, 'print')}
        onOpenTree={(id) => navigate(id, 'chart')}
        onGoHome={() => navigate(null)}
      />
    )
  }

  // Default view for any selected tree: TreeChartPage (with search, unified tree, and edit gate)
  return (
    <TreeChartPage
      treeId={route.treeId}
      onGoToEditor={() => navigate(route.treeId, 'stepped-editor')}
      onGoToPrint={() => navigate(route.treeId, 'print')}
      onGoHome={() => navigate(null)}
    />
  )
}

// ── Redesigned Home Screen ───────────────────────────────────────────────────

const OLD_STORAGE_KEY = 'nasab-tree-state-v1'

function HomeScreen({
  onNavigate,
  onView,
}: {
  onNavigate: (id: string) => void
  onView: (id: string) => void
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

  function requireEditorAccess(action: () => void) {
    if (isEditorUnlocked()) {
      setIsUnlocked(true)
      action()
    } else {
      setPendingAction(() => action)
      setIsCodeModalOpen(true)
    }
  }

  function handleLockEditor() {
    setEditorUnlocked(false)
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
    await deleteSession(id)
    setDeleteConfirm(null)
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
                onClick={() => void handleCreate()}
                disabled={creating}
                title="إنشاء مشجر رئيسي جديد"
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
              title="دخول المحرر وتعديل المشجرات (رمز المرور)"
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
              <p className="migration-title">وُجد مشجر سابق محلّي</p>
              <p className="migration-sub">
                شجرة «{migratingState.root?.name}» موجودة على هذا الجهاز فقط — انقلها إلى السحابة.
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

        {/* ── Minimalist, Elegant Header & Search ── */}
        <section className="home-intro-clean">
          <h1 className="home-page-title">المشجّرات العائلية</h1>
          <p className="home-page-sub">
            سجل أنساب وذرية العائلة — اختر مشجراً لاستعراضه
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
                  {sessions.length} {sessions.length === 1 ? 'مشجر' : 'مشجرات'}
                </span>
              )}
            </div>
          )}
        </section>

        {/* ── Tree Cards Grid ── */}
        {loading ? (
          <div className="home-empty-card">
            <div className="spin" style={{ fontSize: '28px', marginBottom: '12px' }}>⟳</div>
            <p>جارٍ تحميل المشجرات العائلية…</p>
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
                      استعراض المشجر
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
            : '💡 المشجرات متاحة للجميع للاستعراض والقراءة، بينما التعديل محمي برمز مرور العائلة.'}
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
  const [commonFatherName] = useState(() => {
    return localStorage.getItem(`commonFatherName_${treeId}`) || 'محمد'
  })
  const [isLinkModalOpen, setIsLinkModalOpen] = useState(false)
  const [linkModalPerson, setLinkModalPerson] = useState<Person | null>(null)
  const [linkModalTargetBranchId, setLinkModalTargetBranchId] = useState<string | null>(null)

  // Passcode-protection for edit actions (PIN: 2233)
  const [isUnlocked, setIsUnlocked] = useState(isEditorUnlocked)
  const [isCodeModalOpen, setIsCodeModalOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  function requireEditorAccess(action: () => void) {
    if (isEditorUnlocked()) {
      setIsUnlocked(true)
      action()
    } else {
      setPendingAction(() => action)
      setIsCodeModalOpen(true)
    }
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
          <p className="eyebrow">مشجر فارغ</p>
          <h1 style={{ fontSize: '26px', marginBottom: '8px' }}>لم يتم إدخال بيانات هذا المشجر بعد</h1>
          <p className="lede" style={{ margin: '0 auto 20px', maxWidth: '40ch' }}>
            هذا المشجر جديد ولا يحتوي على جد أساسي أو أفراد. يمكنك فتح المحرر لإضافة الجد الأول والبدء في بناء الشجرة.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="primary"
              onClick={() => requireEditorAccess(onGoToEditor)}
            >
              📝 فتح المحرر للبدء بالإدخال
            </button>
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

        {/* Small corner edit button */}
        {isUnlocked ? (
          <button
            type="button"
            className="compact-button editor-auth-badge unlocked"
            onClick={() => {
              setEditorUnlocked(false)
              setIsUnlocked(false)
            }}
            title="وضع التعديل مفعل — انقر للقفل"
          >
            🔓 وضع التعديل (قفل)
          </button>
        ) : (
          <button
            type="button"
            className="compact-button editor-auth-badge"
            onClick={() => requireEditorAccess(() => {})}
            title="تعديل الشجرة (يتطلب الرمز 2233)"
          >
            ✏️ تعديل
          </button>
        )}

        {isUnlocked && (
          <button
            type="button"
            className="compact-button"
            onClick={onGoToEditor}
            title="فتح نموذج الإدخال الكامل"
          >
            📝 نموذج الإدخال
          </button>
        )}

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
              onClick={() => requireEditorAccess(() => void handleLinkExistingTree(treeId, null))}
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
        <VisualTreeChart
          root={displayRoot}
          isUnifiedView={showUnifiedView && !!unifiedResult?.isUnified}
          isEditMode={isUnlocked}
          currentTreeId={treeId}
          currentTreeName={mainTreeName}
          availableTrees={sessions}
          selectedId={selectedId}
          currentId={tree.currentPersonId}
          onSelectPerson={(person) => setSelectedId(person.id)}
          onRequestEditUnlock={() => requireEditorAccess(() => {})}
          onGoToEditorForPerson={() => requireEditorAccess(() => onGoToEditor())}
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

      {/* Editor Code Modal for PIN 2233 */}
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

    if ((tree.phase === 'add-wives' || tree.phase === 'assign-mothers') && tree.malesQueue.length > 0) {
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
  const isMothersPhase = tree.phase === 'assign-mothers'

  const multiWifeCount = useMemo(() => {
    if (!tree.root) return 0
    return collectMalesDFS(tree.root).filter(
      (m) => (m.wives?.length ?? 0) > 1 && (m.children?.length ?? 0) > 0,
    ).length
  }, [tree.root])

  const wivesContinueLabel = useMemo(() => {
    if (!isWivesPhase) return undefined
    const isLast = tree.currentMaleIndex >= tree.malesQueue.length - 1
    if (isLast) {
      return multiWifeCount > 0
        ? 'حفظ والانتقال إلى الأمهات'
        : 'حفظ والإنهاء إلى المراجعة'
    }
    return 'حفظ والانتقال للتالي'
  }, [isWivesPhase, tree.currentMaleIndex, tree.malesQueue.length, multiWifeCount])

  const mothersContinueLabel = useMemo(() => {
    if (!isMothersPhase) return undefined
    const isLast = tree.currentMaleIndex >= tree.malesQueue.length - 1
    return isLast ? 'حفظ والإنهاء إلى المراجعة' : 'حفظ والانتقال للتالي'
  }, [isMothersPhase, tree.currentMaleIndex, tree.malesQueue.length])

  const mothersProgressLabel = useMemo(() => {
    if (!isMothersPhase || tree.malesQueue.length === 0) return ''
    return `رجل ${(tree.currentMaleIndex + 1).toLocaleString('ar')} من ${tree.malesQueue.length.toLocaleString('ar')} (متعدد)`
  }, [isMothersPhase, tree.currentMaleIndex, tree.malesQueue.length])

  const activeFocus = useMemo(() => {
    if (isChildrenPhase) {
      return reviewFocus === 'wives' || reviewFocus === 'mothers' ? reviewFocus : 'children'
    }
    if (isWivesPhase) {
      return reviewFocus === 'children' || reviewFocus === 'mothers' ? reviewFocus : 'wives'
    }
    if (isMothersPhase) {
      return reviewFocus === 'children' || reviewFocus === 'wives' ? reviewFocus : 'mothers'
    }
    return reviewFocus
  }, [isChildrenPhase, isWivesPhase, isMothersPhase, reviewFocus])

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

        {(() => {
          const activeLink = tree.linkedFrom || currentTreeMeta?.linkedFrom
          if (!activeLink) {
            return (
              <button
                type="button"
                className="compact-button"
                onClick={() => setIsLinkModalOpen(true)}
                title="ربط هذه الشجرة كفرع لشجرة أخرى (مثلاً: أخت الجد الخامس هي أم لهذه الشجرة)"
              >
                🔗 ربط كفرع بشجرة أخرى
              </button>
            )
          }
          return (
            <div className="linked-tree-header-badge">
              <button
                type="button"
                className="linked-tree-nav-btn"
                onClick={() => {
                  if (onOpenTree) onOpenTree(activeLink.mainTreeId)
                }}
                title={`الانتقال إلى الشجرة الرئيسية «${activeLink.mainTreeName}»`}
              >
                <span className="badge-icon">
                  {activeLink.type === 'daughter-branch' ? '🧬' : '🤝'}
                </span>
                <span>
                  متصلة بـ «{activeLink.mainTreeName}»
                  {activeLink.personName ? ` (أم/صلة: ${activeLink.personName})` : ''}
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
          )
        })()}

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
            className={`phase-button phase${isMothersPhase ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('assign-mothers')
              setReviewFocus('mothers')
            }}
            title="الانتقال إلى مرحلة ربط الأمهات (للمتزوجين بأكثر من واحدة)"
          >
            ٣ · الأمهات{multiWifeCount > 0 ? ` (${multiWifeCount.toLocaleString('ar')})` : ''}
          </button>
          <button
            type="button"
            className={`phase-button phase${isComplete ? ' active' : ''}`}
            onClick={() => {
              tree.goToPhase('complete')
            }}
            title="الانتقال إلى مرحلة المراجعة"
          >
            ٤ · المراجعة
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
                    continueLabel={wivesContinueLabel}
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
                    isCurrent={!isEditingEarlier && isMothersPhase}
                    progressLabel={mothersProgressLabel}
                    continueLabel={mothersContinueLabel}
                    onSave={(assignments) => {
                      tree.setChildrenMothers(selectedPerson.id, assignments)
                      showSaved(selectedPerson.id)
                    }}
                    onSaveAndContinue={(assignments) => {
                      tree.setMothersAndContinue(selectedPerson.id, assignments)
                      setSelectedId(null)
                    }}
                    onReturnToCurrent={() => setSelectedId(null)}
                    onSkip={isMothersPhase ? () => {
                      tree.skipMotherAndContinue()
                      setSelectedId(null)
                    } : undefined}
                    onBack={() => setReviewFocus(isWivesPhase ? 'wives' : isMothersPhase ? 'mothers' : 'children')}
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
        ) : isMothersPhase && tree.malesQueue.length === 0 ? (
          <section className="stage complete-stage">
            <p className="eyebrow">مرحلة الأمهات</p>
            <h2>لا يوجد رجال متعددو الزوجات</h2>
            <p className="lede">
              جميع الرجال المسجلين في هذه الشجرة لديهم زوجة واحدة فقط أو بدون زوجات.
              تم تعيين أمهات الأبناء تلقائياً لعدم وجود تعدد زوجات يتطلب التحديد اليدوي.
            </p>
            <div className="actions">
              <button
                className="primary"
                type="button"
                onClick={() => tree.goToPhase('complete')}
              >
                الانتقال إلى المراجعة ←
              </button>
              <button
                type="button"
                onClick={() => {
                  tree.goToPhase('add-wives')
                  setReviewFocus('wives')
                }}
              >
                العودة إلى الزوجات
              </button>
            </div>
          </section>
        ) : (
          <section className="stage complete-stage">
            <p className="eyebrow">اكتمل إدخال الأشخاص والزوجات والأمهات</p>
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
              {multiWifeCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setReviewFocus('mothers')
                    tree.startMothersPhase()
                    setSelectedId(null)
                  }}
                >
                  مراجعة الأمهات لمتعددي الزوجات ({multiWifeCount.toLocaleString('ar')})
                </button>
              )}
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
            : isMothersPhase
              ? 'اختر رجلاً لتعديل أمهات أولاده (يتم حصر متعددي الزوجات فقط).'
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
