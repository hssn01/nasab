import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const EDITOR_PIN = Deno.env.get('EDITOR_PIN') ?? ''

/**
 * Newer Supabase projects inject JSON dictionaries
 * (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS) instead of the legacy
 * single-key variables. Support both so this function needs no extra secrets.
 */
function readSupabaseKey(legacyName: string, dictionaryName: string): string {
  const legacy = Deno.env.get(legacyName)
  if (legacy) return legacy

  const raw = Deno.env.get(dictionaryName)
  if (!raw) return ''

  try {
    const keys = JSON.parse(raw) as Record<string, string>
    return keys.default ?? Object.values(keys)[0] ?? ''
  } catch {
    return ''
  }
}

const ANON_KEY = readSupabaseKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS')
const SERVICE_ROLE_KEY = readSupabaseKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS')

const MAX_ATTEMPTS = 10
const WINDOW_MINUTES = 15
const MAX_PIN_LENGTH = 128

function corsHeaders(): Record<string, string> {
  // The PIN is the credential. CORS is not a security boundary here, and
  // keeping it open avoids a second required secret.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Compare two equal-length hex digests without early exit. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

/**
 * There is one shared editor account. It is identified by
 * app_metadata.role = 'editor', the same claim the RLS policies check.
 */
async function findEditorEmail(admin: SupabaseClient): Promise<string | null> {
  let page = 1
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error

    const editor = data.users.find(
      (user) => user.app_metadata?.role === 'editor' && user.email,
    )
    if (editor?.email) return editor.email

    if (!data.nextPage || data.nextPage <= page) return null
    page = data.nextPage
  }
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders()

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers })
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, headers)
  }

  // Only EDITOR_PIN is configured manually. The three Supabase values are
  // injected automatically by the Edge Function runtime.
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !EDITOR_PIN) {
    console.error('[editor-login] missing required environment secrets')
    return json({ error: 'server_misconfigured' }, 500, headers)
  }

  let pin = ''
  try {
    const body = await req.json()
    pin = typeof body?.pin === 'string' ? body.pin.trim() : ''
  } catch {
    return json({ error: 'invalid_request' }, 400, headers)
  }

  if (!pin || pin.length > MAX_PIN_LENGTH) {
    return json({ error: 'invalid_pin' }, 401, headers)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Rate limit by caller IP. The fixed prefix is not a secret; it only avoids
  // storing a raw IP or a generic unsalted hash.
  const ipHash = await sha256(`nasab-editor-login:${clientIp(req)}`)

  try {
    const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString()
    const { count } = await admin
      .from('editor_login_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .eq('success', false)
      .gte('attempted_at', since)

    if ((count ?? 0) >= MAX_ATTEMPTS) {
      return json({ error: 'too_many_attempts' }, 429, headers)
    }
  } catch (err) {
    console.warn('[editor-login] rate-limit check unavailable:', err)
  }

  const [pinHash, expectedHash] = await Promise.all([sha256(pin), sha256(EDITOR_PIN)])
  if (!timingSafeEqual(pinHash, expectedHash)) {
    try {
      await admin.from('editor_login_attempts').insert({
        ip_hash: ipHash,
        success: false,
      })
    } catch (err) {
      console.warn('[editor-login] failed to record attempt:', err)
    }

    // Slow down brute force even when the rate-limit table is unavailable.
    await new Promise((resolve) => setTimeout(resolve, 700))
    return json({ error: 'invalid_pin' }, 401, headers)
  }

  let editorEmail: string | null = null
  try {
    editorEmail = await findEditorEmail(admin)
  } catch (err) {
    console.error('[editor-login] failed to load the editor account:', err)
    return json({ error: 'login_failed' }, 500, headers)
  }

  if (!editorEmail) {
    console.error('[editor-login] no user with app_metadata.role=editor was found')
    return json({ error: 'editor_not_configured' }, 500, headers)
  }

  // Generate a one-time magic-link token for the shared account, then exchange
  // it for a session. This avoids storing a separate editor password secret.
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: editorEmail,
  })

  // supabase-js normally returns properties.hashed_token; accept the raw
  // REST shape too, in case a different client version is used.
  const link = linkData as
    | { properties?: { hashed_token?: string }; hashed_token?: string }
    | null
  const tokenHash = link?.properties?.hashed_token ?? link?.hashed_token

  if (linkError || !tokenHash) {
    console.error('[editor-login] failed to generate the editor session token:', linkError)
    return json({ error: 'login_failed' }, 500, headers)
  }

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: sessionData, error: verifyError } = await authClient.auth.verifyOtp({
    type: 'email',
    token_hash: tokenHash,
  })

  if (verifyError || !sessionData.session) {
    console.error('[editor-login] failed to create the editor session:', verifyError)
    return json({ error: 'login_failed' }, 500, headers)
  }

  if (sessionData.user?.app_metadata?.role !== 'editor') {
    console.error('[editor-login] signed-in user is missing app_metadata.role=editor')
    await authClient.auth.signOut({ scope: 'local' }).catch(() => {})
    return json({ error: 'editor_not_configured' }, 500, headers)
  }

  try {
    await admin.from('editor_login_attempts').delete().eq('ip_hash', ipHash)
  } catch (err) {
    console.warn('[editor-login] failed to clear attempts:', err)
  }

  return json(
    {
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
      expires_in: sessionData.session.expires_in,
      token_type: sessionData.session.token_type,
    },
    200,
    headers,
  )
})
