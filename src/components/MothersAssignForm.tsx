import { useMemo, useState } from 'react'
import type { Person } from '../types'
import { wifeShortLabel } from '../treeUtils'

interface MothersAssignFormProps {
  person: Person
  root: Person
  lineageText: string
  onSave: (assignments: Record<string, string | null>) => void
  onBack?: () => void
}

const UNKNOWN = ''

function displayMotherKey(value: unknown): string {
  if (!value) return UNKNOWN
  if (typeof value === 'object' && value !== null) {
    const raw = value as { id?: unknown; name?: unknown; personId?: unknown }
    return (
      (typeof raw.id === 'string' && raw.id.trim()) ||
      (typeof raw.name === 'string' && raw.name.trim()) ||
      (typeof raw.personId === 'string' && raw.personId.trim()) ||
      UNKNOWN
    )
  }
  return typeof value === 'string' ? value.trim() : UNKNOWN
}

export function MothersAssignForm({
  person,
  root,
  lineageText,
  onSave,
  onBack,
}: MothersAssignFormProps) {
  const [assignments, setAssignments] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const child of person.children) {
      initial[child.id] = displayMotherKey(child.mother)
    }
    return initial
  })

  const wives = person.wives
  const children = person.children
  const wifeIds = useMemo(() => new Set(wives.map((wife) => wife.id)), [wives])

  const assignedCount = useMemo(
    () => children.filter((child) => assignments[child.id]?.trim()).length,
    [assignments, children],
  )

  function setMother(childId: string, value: string) {
    setAssignments((prev) => ({ ...prev, [childId]: value }))
  }

  function assignAll(wifeId: string) {
    setAssignments((prev) => {
      const next = { ...prev }
      for (const child of children) next[child.id] = wifeId
      return next
    })
  }

  function handleSave() {
    const payload: Record<string, string | null> = {}
    for (const child of children) {
      const value = assignments[child.id]?.trim() || null
      payload[child.id] = value
    }
    onSave(payload)
  }

  if (children.length === 0) {
    return (
      <section className="batch-entry" aria-labelledby="mothers-entry-title">
        <div className="batch-heading">
          <div>
            <p className="eyebrow entry-context" title={lineageText}>
              <span>الأمهات</span>
              <span className="context-separator">·</span>
              <span className="context-lineage" dir="rtl">
                {lineageText}
              </span>
            </p>
            <h2 id="mothers-entry-title">لا أبناء مسجّلون</h2>
          </div>
          <span className="person-code">{person.id}</span>
        </div>
        <p className="entry-help">
          أدخل الأبناء والبنات أولاً، ثم اربط كل واحد بأمه من الزوجات.
        </p>
        {onBack && (
          <div className="batch-actions">
            <button type="button" onClick={onBack}>
              رجوع
            </button>
          </div>
        )}
      </section>
    )
  }

  if (wives.length === 0) {
    return (
      <section className="batch-entry" aria-labelledby="mothers-entry-title">
        <div className="batch-heading">
          <div>
            <p className="eyebrow entry-context" title={lineageText}>
              <span>الأمهات</span>
              <span className="context-separator">·</span>
              <span className="context-lineage" dir="rtl">
                {lineageText}
              </span>
            </p>
            <h2 id="mothers-entry-title">لا زوجات مسجّلات بعد</h2>
          </div>
          <span className="person-code">{person.id}</span>
        </div>
        <p className="entry-help">
          سجّل زوجات هذا الرجل أولاً من تبويب الزوجات، ثم عيّن أم كل ولد.
        </p>
        {onBack && (
          <div className="batch-actions">
            <button type="button" onClick={onBack}>
              رجوع
            </button>
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="batch-entry" aria-labelledby="mothers-entry-title">
      <div className="batch-heading">
        <div>
          <p className="eyebrow entry-context" title={lineageText}>
            <span>ربط الأمهات</span>
            <span className="context-separator">·</span>
            <span className="context-lineage" dir="rtl">
              {lineageText}
            </span>
          </p>
          <h2 id="mothers-entry-title">أمّ كل ولد من أولاد {person.name}</h2>
        </div>
        <div className="batch-heading-meta">
          <span className="person-code">{person.id}</span>
          <span className="wives-progress">
            {assignedCount.toLocaleString('ar')} /{' '}
            {children.length.toLocaleString('ar')} معيّن
          </span>
        </div>
      </div>

      <p className="entry-help">
        لأن للرجل أكثر من زوجة أحياناً، عيّن أم كل ابن وبنت من قائمة الزوجات.
        اترك «غير معروفة» إن لم يذكر الكتاب الأم.
      </p>

      {wives.length > 1 && (
        <div className="mothers-bulk">
          <span className="mothers-bulk-label">تعيين الكل:</span>
          {wives.map((wife) => (
            <button
              key={wife.id}
              type="button"
              className="compact-button"
              onClick={() => assignAll(wife.id)}
            >
              {wifeShortLabel(wife, root)}
            </button>
          ))}
          <button
            type="button"
            className="compact-button"
            onClick={() => assignAll(UNKNOWN)}
          >
            غير معروفة
          </button>
        </div>
      )}

      <ul className="mothers-assign-list" role="list">
        {children.map((child) => (
          <li key={child.id} className="mothers-assign-row">
            <div className="mothers-child-info">
              <span
                className={`person-code${child.gender === 'F' ? ' female-code' : ''}`}
              >
                {child.id}
              </span>
              <span className="mothers-child-name" dir="auto">
                {child.name}
              </span>
              <span className="mothers-child-gender">
                {child.gender === 'M' ? 'ابن' : 'بنت'}
              </span>
            </div>
            <label className="mothers-select-label">
              <span className="visually-hidden">أم {child.name}</span>
              <select
                dir="rtl"
                value={assignments[child.id] ?? UNKNOWN}
                onChange={(event) => setMother(child.id, event.target.value)}
              >
                <option value={UNKNOWN}>غير معروفة</option>
                {wives.map((wife) => (
                  <option key={wife.id} value={wife.id}>
                    {wifeShortLabel(wife, root)}
                  </option>
                ))}
                {assignments[child.id] &&
                  assignments[child.id] !== UNKNOWN &&
                  !wifeIds.has(assignments[child.id]) && (
                    <option value={assignments[child.id]}>
                      {assignments[child.id]} (غير في القائمة)
                    </option>
                  )}
              </select>
            </label>
          </li>
        ))}
      </ul>

      <div className="batch-actions">
        <button type="button" className="primary" onClick={handleSave}>
          حفظ الأمهات
        </button>
        {onBack && (
          <button type="button" onClick={onBack}>
            رجوع
          </button>
        )}
      </div>
    </section>
  )
}
