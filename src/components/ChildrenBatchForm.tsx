import { useMemo, useState } from 'react'
import type { Person } from '../types'

interface ChildrenBatchFormProps {
  person: Person
  lineageText: string
  isCurrent: boolean
  canDelete: boolean
  onSave: (sons: string[], daughters: string[]) => void
  onSaveAndContinue: (sons: string[], daughters: string[]) => void
  onRename: (name: string) => void
  onDelete: () => void
  onReturnToCurrent: () => void
}

const LIST_MARKER =
  /^\s*(?:(?:\d+|[٠-٩]+)\s*[-–—.):،]\s*|[-–—•▪◦*]\s*)/

function cleanLine(line: string): string {
  return line.replace(LIST_MARKER, '').trim()
}

function parseNames(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean)
}

function namesOf(person: Person, gender: 'M' | 'F'): string {
  return person.children
    .filter((child) => child.gender === gender)
    .map((child) => child.name)
    .join('\n')
}

export function ChildrenBatchForm({
  person,
  lineageText,
  isCurrent,
  canDelete,
  onSave,
  onSaveAndContinue,
  onRename,
  onDelete,
  onReturnToCurrent,
}: ChildrenBatchFormProps) {
  const [personName, setPersonName] = useState(person.name)
  const [sonsText, setSonsText] = useState(() => namesOf(person, 'M'))
  const [daughtersText, setDaughtersText] = useState(() => namesOf(person, 'F'))
  const [confirmDelete, setConfirmDelete] = useState(false)

  const sons = useMemo(() => parseNames(sonsText), [sonsText])
  const daughters = useMemo(() => parseNames(daughtersText), [daughtersText])

  return (
    <section className="batch-entry" aria-labelledby="children-entry-title">
      <div className="batch-heading">
        <div>
          <p className="eyebrow entry-context" title={lineageText}>
            <span>{isCurrent ? 'الإدخال الحالي' : 'تعديل أسرة سابقة'}</span>
            <span className="context-separator">·</span>
            <span className="context-lineage" dir="rtl">
              {lineageText}
            </span>
          </p>
          <div className="editable-person-name">
            <span>أولاد</span>
            <input
              id="children-entry-title"
              type="text"
              dir="rtl"
              value={personName}
              onChange={(event) => setPersonName(event.target.value)}
              onBlur={() => {
                if (personName.trim()) onRename(personName)
              }}
              aria-label="اسم الشخص"
            />
          </div>
        </div>
        <span className="person-code">{person.id}</span>
      </div>

      <p className="entry-help">
        الصق اسماً واحداً في كل سطر، بالترتيب الوارد في الكتاب من الأكبر إلى
        الأصغر. تُحذف أرقام القوائم تلقائياً.
      </p>

      <div className="batch-fields">
        <label className="batch-field field-sons">
          <span className="field-header">
            <strong>الأبناء</strong>
            <span>{sons.length}</span>
          </span>
          <textarea
            dir="rtl"
            value={sonsText}
            onChange={(event) => setSonsText(event.target.value)}
            placeholder={'محمد\nأحمد\nعبد الله'}
            rows={12}
            spellCheck
          />
        </label>

        <label className="batch-field field-daughters">
          <span className="field-header">
            <strong>البنات</strong>
            <span>{daughters.length}</span>
          </span>
          <textarea
            dir="rtl"
            value={daughtersText}
            onChange={(event) => setDaughtersText(event.target.value)}
            placeholder={'فاطمة\nخديجة\nمريم'}
            rows={12}
            spellCheck
          />
        </label>
      </div>

      <div className="batch-actions">
        {isCurrent ? (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onRename(personName)
                onSaveAndContinue(sons, daughters)
              }}
            >
              حفظ والانتقال إلى الابن الأول
            </button>
            <button
              type="button"
              onClick={() => {
                onRename(personName)
                onSave(sons, daughters)
              }}
            >
              حفظ فقط
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onRename(personName)
                onSave(sons, daughters)
              }}
            >
              حفظ التعديلات
            </button>
            <button type="button" onClick={onReturnToCurrent}>
              العودة إلى موضع الإدخال
            </button>
          </>
        )}
        {canDelete &&
          (confirmDelete ? (
            <span className="delete-confirm">
              سيُحذف هذا الشخص وكل فرعه.
              <button type="button" className="danger" onClick={onDelete}>
                تأكيد الحذف
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                إلغاء
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ghost danger-text"
              onClick={() => setConfirmDelete(true)}
            >
              حذف الشخص
            </button>
          ))}
      </div>
    </section>
  )
}
