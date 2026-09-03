import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key && !url.includes('xxxx'))

// Safe fallback so the app doesn't crash if env vars are missing
export const supabase = isConfigured
  ? createClient(url!, key!)
  : createClient('https://placeholder.supabase.co', 'placeholder')
