import { createClient } from '@supabase/supabase-js'

const DEFAULT_SUPABASE_URL = 'https://zkognjfhmxiviuuovqvv.supabase.co'
const DEFAULT_SUPABASE_KEY = 'sb_publishable_603N0vfRCbYcCLAADAoU1Q_9x23h76C'

// Deployment environments created before the database migration still contain
// this retired project URL. Ignore the stale pair instead of silently pointing
// the app at an empty/old database.
const RETIRED_SUPABASE_HOST = 'vauzitsqzvuugudlxrrc.supabase.co'

const configuredUrl =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  (import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined)

const configuredKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  (import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  (import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined)

const useConfiguredSupabase = Boolean(
  configuredUrl && !configuredUrl.includes(RETIRED_SUPABASE_HOST),
)

const url = useConfiguredSupabase ? configuredUrl! : DEFAULT_SUPABASE_URL
const key = useConfiguredSupabase
  ? configuredKey || DEFAULT_SUPABASE_KEY
  : DEFAULT_SUPABASE_KEY

export const isConfigured = Boolean(url && key && !url.includes('xxxx'))

export const supabase = createClient(url, key)

