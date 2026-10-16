import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { migrateAllLocalSessions } from './localDb'
import { migrateSupabaseToRelational } from './db'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Run one-time migrations silently in the background after render
migrateAllLocalSessions().catch(console.warn)
migrateSupabaseToRelational().catch(console.warn)
