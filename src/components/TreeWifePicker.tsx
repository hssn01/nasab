import { useEffect, useMemo, useRef, useState } from 'react'
import type { Person, TreeMeta } from '../types'
import {
  collectFemalesWithLineage,
  collectMalesDFS,
  type FemaleWithLineage,
} from '../treeUtils'
import { fetchTreeState, getCachedState, getCachedTreeList } from '../db'
import { getSession, getAllSessions } from '../localDb'

// ── Arabic normalization ─────────────────────────────────────────────────────
function normalizeArabic(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0640\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .trim()
}

// ── Props ────────────────────────────────────────────────────────────────────

interface TreeWifePickerProps {
  root: Person
  linkedIds: Set<string>
  currentTreeId?: string
  currentTreeName?: string
  availableTrees?: TreeMeta[]
  onSelect: (
    personId: string,
    extra?: {
      treeId?: string
      treeName?: string
      personName?: string
      lineageLabel?: string
    },
  ) => void
  onCreateAndLink: (fatherId: string, name: string) => string | null
  onCancel: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function TreeWifePicker({
  root,
  linkedIds,
  currentTreeId,
  currentTreeName,
  availableTrees,
  onSelect,
  onCreateAndLink,
  onCancel,
}: TreeWifePickerProps) {
  const [selectedTreeId, setSelectedTreeId] = useState<string>(
    currentTreeId || '__CURRENT__',
  )
  const [trees, setTrees] = useState<TreeMeta[]>(availableTrees || [])
  const [loadedRoots, setLoadedRoots] = useState<Record<string, Person>>({})
  const [isLoadingTree, setIsLoadingTree] = useState(false)
  const [treeLoadError, setTreeLoadError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [fatherFilter, setFatherFilter] = useState('')
  const [createMode, setCreateMode] = useState(false)
  const [createFatherId, setCreateFatherId] = useState('')
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Populate trees list if not passed from parent
  useEffect(() => {
    if (availableTrees && availableTrees.length > 0) {
      setTrees(availableTrees)
    } else {
      const cached = getCachedTreeList()
      if (cached.length > 0) {
        setTrees(cached)
      } else {
        getAllSessions()
          .then((sessions) => {
            if (sessions.length > 0) {
              setTrees(
                sessions.map((s) => ({
                  id: s.id,
                  name: s.name,
                  updated_at: s.updated_at,
                  rootAncestor: s.rootAncestor,
                  linkedFrom: s.linkedFrom,
                })),
              )
            }
          })
          .catch(() => {})
      }
    }
  }, [availableTrees])

  // Load tree state when user chooses a different tree
  useEffect(() => {
    if (selectedTreeId === '__CURRENT__' || selectedTreeId === currentTreeId) {
      return
    }
    if (loadedRoots[selectedTreeId]) {
      return
    }

    setIsLoadingTree(true)
    setTreeLoadError(null)

    async function loadTree() {
      try {
        const cachedState = getCachedState(selectedTreeId)
        if (cachedState?.root) {
          setLoadedRoots((prev) => ({ ...prev, [selectedTreeId]: cachedState.root! }))
          setIsLoadingTree(false)
          return
        }

        const session = await getSession(selectedTreeId)
        if (session?.state?.root) {
          setLoadedRoots((prev) => ({ ...prev, [selectedTreeId]: session.state.root! }))
          setIsLoadingTree(false)
          return
        }

        const remoteState = await fetchTreeState(selectedTreeId)
        if (remoteState?.root) {
          setLoadedRoots((prev) => ({ ...prev, [selectedTreeId]: remoteState.root! }))
        } else {
          setTreeLoadError('تعذّر العثور على شجرة مسجلة أو بيانات النسب.')
        }
      } catch (err: any) {
        setTreeLoadError(err?.message || 'حدث خطأ أثناء تحميل الشجرة.')
      } finally {
        setIsLoadingTree(false)
      }
    }

    void loadTree()
  }, [selectedTreeId, currentTreeId, loadedRoots])

  const isCurrentTree =
    selectedTreeId === '__CURRENT__' || selectedTreeId === currentTreeId
  const activeRoot: Person | null = isCurrentTree
    ? root
    : loadedRoots[selectedTreeId] || null

  const selectedTreeMeta = trees.find((t) => t.id === selectedTreeId)
  const activeTreeName = isCurrentTree
    ? currentTreeName || 'هذه الشجرة'
    : selectedTreeMeta?.name || 'الشجرة المحددة'

  const males = useMemo(
    () => (activeRoot ? collectMalesDFS(activeRoot) : []),
    [activeRoot],
  )

  const femalesWithLineage = useMemo(() => {
    if (!activeRoot) return []
    const all = collectFemalesWithLineage(activeRoot)
    return isCurrentTree
      ? all.filter(({ person }) => !linkedIds.has(person.id))
      : all
  }, [activeRoot, isCurrentTree, linkedIds])

  const filtered = useMemo(() => {
    const normQ = normalizeArabic(query)
    return femalesWithLineage.filter(({ person, lineageLabel, father }) => {
      if (fatherFilter && father?.id !== fatherFilter) return false
      if (!normQ) return true
      const haystack = normalizeArabic(lineageLabel + ' ' + person.id)
      return haystack.includes(normQ)
    })
  }, [femalesWithLineage, query, fatherFilter])

  function handleSelect(item: FemaleWithLineage) {
    if (isCurrentTree) {
      onSelect(item.person.id)
    } else {
      onSelect(item.person.id, {
        treeId: selectedTreeId,
        treeName: activeTreeName,
        personName: item.person.name,
        lineageLabel: item.lineageLabel,
      })
    }
  }

  function handleCreate() {
    setCreateError('')
    if (!createFatherId) {
      setCreateError('اختر الأب من القائمة أولاً.')
      return
    }
    if (!createName.trim()) {
      setCreateError('أدخل اسم البنت.')
      return
    }
    const newId = onCreateAndLink(createFatherId, createName.trim())
    if (!newId) {
      setCreateError('تعذّر إنشاء السجل. حاول مجدداً.')
    }
  }

  return (
    <div
      className="twp-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="اختيار زوجة من الأشجار العائلية"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="twp-panel" dir="rtl">
        <header className="twp-header">
          <div>
            <h2 className="twp-title">اختيار زوجة من أشجار العائلة</h2>
            <p className="twp-subtitle">
              يمكنك اختيار الزوجة من الشجرة الحالية أو من أي شجرة أخرى من أشجارك
            </p>
          </div>
          <button
            type="button"
            className="twp-close"
            onClick={onCancel}
            aria-label="إغلاق"
          >
            ×
          </button>
        </header>

        {/* ── Tree Selector Row ── */}
        <div className="twp-tree-selector-row">
          <label className="twp-filter-label" htmlFor="twp-tree-select">
            🌳 مصدر الزوجة (اختر الشجرة):
          </label>
          <select
            id="twp-tree-select"
            className="twp-tree-select"
            dir="rtl"
            value={selectedTreeId}
            onChange={(e) => {
              setSelectedTreeId(e.target.value)
              setFatherFilter('')
              setQuery('')
              setCreateMode(false)
            }}
          >
            <option value={currentTreeId || '__CURRENT__'}>
              🌿 الشجرة الحالية ({currentTreeName || 'هذه الشجرة'})
            </option>
            {trees
              .filter((t) => t.id !== currentTreeId && t.id !== '__CURRENT__')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.linkedFrom?.type === 'daughter-branch'
                    ? '🧬 فرع بنت: '
                    : t.linkedFrom?.type === 'brother-branch'
                    ? '🤝 فرع أخ: '
                    : '🌳 '}
                  {t.name} {t.rootAncestor ? `(الأصل: ${t.rootAncestor})` : ''}
                </option>
              ))}
          </select>
        </div>

        {isLoadingTree ? (
          <div className="twp-loading-box">
            <div className="spin" style={{ fontSize: '22px', marginBottom: '8px' }}>⟳</div>
            <p>جارٍ تحميل نساء الشجرة «{activeTreeName}»…</p>
          </div>
        ) : treeLoadError ? (
          <div className="twp-error-box" role="alert">
            <p>{treeLoadError}</p>
          </div>
        ) : !createMode ? (
          <>
            <div className="twp-search-row">
              <input
                ref={searchRef}
                type="search"
                className="twp-search-input"
                dir="rtl"
                placeholder={`ابحث بالاسم، أو الأب في «${activeTreeName}»…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                aria-label="بحث"
              />
            </div>

            <div className="twp-filter-row">
              <label className="twp-filter-label" htmlFor="twp-father-filter">
                تصفية حسب الأب ({activeTreeName}):
              </label>
              <select
                id="twp-father-filter"
                className="twp-father-select"
                dir="rtl"
                value={fatherFilter}
                onChange={(e) => setFatherFilter(e.target.value)}
              >
                <option value="">— كل الفروع في هذه الشجرة —</option>
                {males.map((male) => (
                  <option key={male.id} value={male.id}>
                    {male.name} ({male.id})
                  </option>
                ))}
              </select>
            </div>

            <ul className="twp-results" role="listbox" aria-label="نتائج البحث">
              {filtered.length === 0 ? (
                <li className="twp-empty">
                  {femalesWithLineage.length === 0
                    ? `لا توجد نساء مسجلات في «${activeTreeName}» بعد.`
                    : 'لا نتائج تطابق البحث.'}
                </li>
              ) : (
                filtered.map((item) => (
                  <li
                    key={`${selectedTreeId}-${item.person.id}`}
                    className="twp-result-item"
                    role="option"
                    aria-selected="false"
                    onClick={() => handleSelect(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') handleSelect(item)
                    }}
                    tabIndex={0}
                  >
                    <div className="twp-result-main">
                      <span className="person-code female-code" dir="ltr">
                        {item.person.id}
                      </span>
                      <span className="twp-result-lineage" dir="rtl">
                        {item.lineageLabel}
                      </span>
                      {!isCurrentTree && (
                        <span className="other-tree-pill" title="من شجرة أخرى">
                          من: {activeTreeName}
                        </span>
                      )}
                    </div>
                    {item.father && (
                      <span className="twp-result-father">
                        الأب: {item.father.name}
                        <span className="twp-result-father-id" dir="ltr">
                          {' '}({item.father.id})
                        </span>
                      </span>
                    )}
                  </li>
                ))
              )}
            </ul>

            {isCurrentTree ? (
              <div className="twp-create-link-row">
                <button
                  type="button"
                  className="twp-create-link"
                  onClick={() => {
                    setCreateMode(true)
                    setCreateError('')
                  }}
                >
                  + إضافة بنت جديدة لأحد رجال الشجرة الحالية وربطها فوراً
                </button>
              </div>
            ) : (
              <p className="twp-cross-tree-hint">
                💡 اختيارك من «{activeTreeName}» سيربط الزوجة بنسبها الأصلي ويوثق صلة النسب والمصاهرة بين الشجرتين.
              </p>
            )}
          </>
        ) : (
          <div className="twp-create-form">
            <p className="twp-create-desc">
              اختر الأب من رجال الشجرة، ثم أدخل اسم البنت. ستُضاف إلى الشجرة
              تحت أبيها وتُربط فوراً كزوجة.
            </p>

            <label className="twp-create-field">
              <span>الأب في الشجرة</span>
              <select
                dir="rtl"
                value={createFatherId}
                onChange={(e) => setCreateFatherId(e.target.value)}
                autoFocus
              >
                <option value="">— اختر الأب —</option>
                {males.map((male) => (
                  <option key={male.id} value={male.id}>
                    {male.name} ({male.id})
                  </option>
                ))}
              </select>
            </label>

            <label className="twp-create-field">
              <span>اسم البنت</span>
              <input
                type="text"
                dir="rtl"
                placeholder="مثال: فاطمة"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                }}
              />
            </label>

            {createError && (
              <p className="twp-create-error" role="alert">
                {createError}
              </p>
            )}

            <div className="twp-create-actions">
              <button
                type="button"
                className="primary"
                onClick={handleCreate}
                disabled={!createFatherId || !createName.trim()}
              >
                إضافة وربط
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreateMode(false)
                  setCreateError('')
                }}
              >
                رجوع إلى البحث
              </button>
            </div>
          </div>
        )}

        <div className="twp-footer">
          <button type="button" onClick={onCancel}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  )
}
