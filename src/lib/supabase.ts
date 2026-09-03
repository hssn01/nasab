import { createClient } from '@supabase/supabase-js'

const url =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
  'https://vauzitsqzvuugudlxrrc.supabase.co'

const key =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhdXppdHNxenZ1dWd1ZGx4cnJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NjI3ODMsImV4cCI6MjEwNDAzODc4M30.VRAyNkPrTT3E-deNHGlAYa3hrykGJpFmJ2xWKwRFzo0'

export const isConfigured = Boolean(url && key && !url.includes('xxxx'))

export const supabase = createClient(url, key)

