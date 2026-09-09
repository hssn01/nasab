import { useMemo, useRef, useState } from 'react'
import type { Person } from '../types'
import {
  collectFemalesWithLineage,
  collectMalesDFS,
  type FemaleWithLineage,
} from '../treeUtils'

// ── Arabic normalization (mirrors treeUtils internal) ────────────────────────
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
  onSelect: (personId: string) => void
  onCreateAndLink: (fatherId: string, name: string) => string | null
  onCancel: () => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function TreeWifePicker({
  root,
  linkedIds,
  onSelect,
  onCreateAndLink,
  onCancel,
}: TreeWifePickerProps) {
  const [query, setQuery] = useState('')
  const [fatherFilter, setFatherFilter] = useState('')
  const [createMode, setCreateMode] = useState(false)
  const [createFatherId, setCreateFatherId] = useState('')
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const males = useMemo(() => collectMalesDFS(root), [root])

  const femalesWithLineage = useMemo(
    () =>
      collectFemalesWithLineage(root).filter(
        ({ person }) => !linkedIds.has(person.id),
      ),
    [root, linkedIds],
  )

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
    onSelect(item.person.id)
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
      aria-label="اختيار زوجة من الشجرة"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="twp-panel" dir="rtl">
        <header className="twp-header">
          <h2 className="twp-title">اختيار زوجة من الشجرة</h2>
          <button
            type="button"
            className="twp-close"
            onClick={onCancel}
            aria-label="إغلاق"
          >
            ×
          </button>
        </header>

        {!createMode ? (
          <>
            <div className="twp-search-row">
              <input
                ref={searchRef}
                type="search"
                className="twp-search-input"
                dir="rtl"
                placeholder="ابحثي بالاسم، أو اسم الأب، أو رمز المعرّف…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                aria-label="بحث"
              />
            </div>

            <div className="twp-filter-row">
              <label className="twp-filter-label" htmlFor="twp-father-filter">
                تصفية حسب الأب:
              </label>
              <select
                id="twp-father-filter"
                className="twp-father-select"
                dir="rtl"
                value={fatherFilter}
                onChange={(e) => setFatherFilter(e.target.value)}
              >
                <option value="">— كل الفروع —</option>
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
                    ? 'لا توجد نساء في الشجرة بعد.'
                    : 'لا نتائج تطابق البحث.'}
                </li>
              ) : (
                filtered.map((item) => (
                  <li
                    key={item.person.id}
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

            <div className="twp-create-link-row">
              <button
                type="button"
                className="twp-create-link"
                onClick={() => {
                  setCreateMode(true)
                  setCreateError('')
                }}
              >
                + إضافة بنت جديدة لأحد رجال الشجرة وربطها كزوجة
              </button>
            </div>
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
