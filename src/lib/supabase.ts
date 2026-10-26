import { createClient } from '@supabase/supabase-js'

const url =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  (import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined) ||
  'https://zkognjfhmxiviuuovqvv.supabase.co'

const key =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  (import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  (import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string | undefined) ||
  'sb_publishable_603N0vfRCbYcCLAADAoU1Q_9x23h76C'

export const isConfigured = Boolean(url && key && !url.includes('xxxx'))

export const supabase = createClient(url, key)

