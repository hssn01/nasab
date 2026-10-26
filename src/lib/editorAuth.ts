import { supabase } from './supabase'

/** sessionStorage key that remembers "this tab unlocked the editor UI". */
export const STORAGE_ACCESS_KEY = 'nasab_editor_unlocked'

/**
 * The UI unlock flag is only a convenience. It lives in sessionStorage and can
 * outlive the real Supabase session (for example after the editor refresh token
 * was revoked server-side). When that happened, write buttons kept firing as
 * `anon` and Postgres answered with "permission denied for table tree_links".
 *
 * The functions below keep the flag honest and let callers fail with a clear
 * "please re-enter the PIN" message instead of a raw RLS/privilege error.
 */
export class EditorSessionError extends Error {
  constructor() {
    super('انتهت جلسة المحرر. يرجى إدخال رمز المرور من جديد.')
    this.name = 'EditorSessionError'
  }
}

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

/**
 * Return a Supabase session that is present and not about to expire, refreshing
 * it when needed. Returns null when the browser is not signed in as the editor.
 */
export async function getValidEditorSession() {
  try {
    const { data } = await supabase.auth.getSession()
    let session = data.session
    if (!session) return null

    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0
    if (expiresAt && expiresAt <= Date.now() + 15_000) {
      const { data: refreshed, error } = await supabase.auth.refreshSession()
      if (error || !refreshed.session) return null
      session = refreshed.session
    }
    return session
  } catch {
    return null
  }
}

export async function hasEditorSession(): Promise<boolean> {
  return (await getValidEditorSession()) !== null
}

/** Throw EditorSessionError when the editor session is missing or expired. */
export async function ensureEditorSession(): Promise<void> {
  if (!(await hasEditorSession())) {
    setEditorUnlocked(false)
    throw new EditorSessionError()
  }
}

/**
 * Reconcile the sessionStorage unlock flag with the real session.
 * Returns true when the editor still has a usable session.
 */
export async function reconcileEditorUnlock(): Promise<boolean> {
  const valid = await hasEditorSession()
  if (!valid) setEditorUnlocked(false)
  return valid
}
