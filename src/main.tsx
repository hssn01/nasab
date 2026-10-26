import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { migrateAllLocalSessions } from './localDb'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Run the one-time local migration silently in the background after render.
if ('requestIdleCallback' in window) {
  window.requestIdleCallback(() => migrateAllLocalSessions().catch(console.warn))
} else {
  setTimeout(() => migrateAllLocalSessions().catch(console.warn), 0)
}
