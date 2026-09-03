import { useState } from 'react'
import type { Person } from '../types'

interface PersonEditorProps {
  person: Person
  onRename: (name: string) => void
  onDelete: () => void
  onBack: () => void
}

export function PersonEditor({
  person,
  onRename,
  onDelete,
  onBack,
}: PersonEditorProps) {
  const [name, setName] = useState(person.name)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <section className="person-editor">
      <div className="batch-heading">
        <div>
          <p className="eyebrow">تعديل شخص</p>
          <h2>بيانات البنت</h2>
        </div>
        <span className="person-code female-code">{person.id}</span>
      </div>

      <label className="single-field">
        <span>الاسم</span>
        <input
          type="text"
          dir="rtl"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </label>

      <div className="batch-actions">
        <button
          type="button"
          className="primary"
          onClick={() => onRename(name)}
        >
          حفظ الاسم
        </button>
        <button type="button" onClick={onBack}>
          العودة إلى موضع الإدخال
        </button>
        {confirmDelete ? (
          <span className="delete-confirm">
            <span>سيُحذف هذا الشخص.</span>
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
        )}
      </div>
    </section>
  )
}
