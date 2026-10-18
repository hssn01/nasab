import React, { useState, useRef, useEffect } from 'react'

export const EDITOR_PASSCODE = '2233'
export const STORAGE_ACCESS_KEY = 'nasab_editor_unlocked'

export function isEditorUnlocked(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_ACCESS_KEY) === 'true'
  } catch {
    return false
  }
}

export function setEditorUnlocked(unlocked: boolean): void {
  try {
    if (unlocked) {
      sessionStorage.setItem(STORAGE_ACCESS_KEY, 'true')
    } else {
      sessionStorage.removeItem(STORAGE_ACCESS_KEY)
    }
  } catch {}
}

export function EditorCodeModal({
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
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [isOpen])

  if (!isOpen) return null

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (code.trim() === EDITOR_PASSCODE) {
      setEditorUnlocked(true)
      onSuccess()
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

        <h3 className="editor-modal-title">رمز تعديل السجل</h3>
        <p className="editor-modal-sub">
          أدخل رمز المرور للتمكن من تعديل وحفظ بيانات السجل العائلي
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
              تأكيد والدخول للتعديل
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
