import React, { useState, useRef, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import {
  STORAGE_ACCESS_KEY,
  isEditorUnlocked,
  setEditorUnlocked,
} from '../lib/editorAuth'

// Re-export so existing imports from this module keep working.
export { STORAGE_ACCESS_KEY, isEditorUnlocked, setEditorUnlocked }

export interface EditorAuthResult {
  ok: boolean
  error?: 'missing-pin' | 'invalid' | 'rate-limit' | 'network' | 'service'
}

/**
 * Verifies the editor passcode on the server (Supabase Edge Function) and
 * installs the returned Supabase Auth session. The passcode itself is never
 * stored in the client bundle.
 */
export async function verifyEditorPin(pin: string): Promise<EditorAuthResult> {
  const trimmed = pin.trim()
  if (!trimmed) return { ok: false, error: 'missing-pin' }

  try {
    const { data, error } = await supabase.functions.invoke('editor-login', {
      body: { pin: trimmed },
    })

    if (error) {
      // Supabase functions.invoke reports non-2xx responses as an error and
      // leaves `data` empty. Read the JSON body from the Response so we can
      // distinguish a wrong PIN from a network/service failure.
      let errorPayload: { error?: string } | null = null
      try {
        const context = (error as { context?: Response }).context
        if (context && typeof context.json === 'function') {
          errorPayload = await context.json()
        }
      } catch {
        // ignore malformed error bodies
      }

      if (errorPayload?.error === 'invalid_pin') return { ok: false, error: 'invalid' }
      if (errorPayload?.error === 'too_many_attempts') {
        return { ok: false, error: 'rate-limit' }
      }

      console.warn('[nasab] editor-login request failed:', error)
      return { ok: false, error: 'network' }
    }

    const payload = data as
      | { access_token?: string; refresh_token?: string; error?: string }
      | null

    if (payload?.error === 'invalid_pin') return { ok: false, error: 'invalid' }
    if (payload?.error === 'too_many_attempts') return { ok: false, error: 'rate-limit' }
    if (!payload?.access_token || !payload?.refresh_token) {
      return { ok: false, error: 'service' }
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
    })

    if (sessionError) {
      console.warn('[nasab] Failed to install editor session:', sessionError)
      return { ok: false, error: 'service' }
    }

    setEditorUnlocked(true)
    return { ok: true }
  } catch (err) {
    console.warn('[nasab] editor-login unavailable:', err)
    return { ok: false, error: 'network' }
  }
}

export async function signOutEditor(): Promise<void> {
  setEditorUnlocked(false)
  try {
    // The editor account is shared. A global sign-out would revoke every
    // editor's refresh token, so lock only this browser's session.
    await supabase.auth.signOut({ scope: 'local' })
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
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setCode('')
      setError(null)
      setIsSubmitting(false)
      setTimeout(() => inputRef.current?.focus(), 80)
    }
  }, [isOpen])

  if (!isOpen) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isSubmitting) return

    setIsSubmitting(true)
    setError(null)
    const result = await verifyEditorPin(code)

    if (result.ok) {
      onSuccess()
      onClose()
    } else {
      setError(getEditorAuthErrorMessage(result.error))
      setCode('')
      inputRef.current?.focus()
    }
    setIsSubmitting(false)
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
              inputMode="text"
              maxLength={64}
              placeholder="••••••••"
              value={code}
              onChange={(e) => {
                setError(null)
                setCode(e.target.value)
              }}
              className={`editor-code-input ${error ? 'code-input-error' : ''}`}
              autoComplete="current-password"
              disabled={isSubmitting}
            />
          </div>

          {error && (
            <div className="editor-modal-error-alert" role="alert">
              <span>⚠️ {error}</span>
            </div>
          )}

          <div className="editor-modal-actions">
            <button
              type="submit"
              className="primary editor-modal-submit-btn"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'جارٍ التحقق…' : 'تأكيد والدخول للتعديل'}
            </button>
            <button
              type="button"
              className="compact-button editor-modal-cancel-btn"
              onClick={onClose}
              disabled={isSubmitting}
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function getEditorAuthErrorMessage(error?: EditorAuthResult['error']): string {
  switch (error) {
    case 'invalid':
      return 'الرمز غير صحيح، يرجى المحاولة مرة أخرى'
    case 'rate-limit':
      return 'محاولات كثيرة. يرجى المحاولة بعد 15 دقيقة'
    case 'missing-pin':
      return 'يرجى إدخال رمز المرور'
    case 'network':
    case 'service':
    default:
      return 'تعذّر التحقق من الرمز. تحقق من الاتصال أو من نشر خدمة الدخول'
  }
}
