import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const targetDir = path.resolve(rootDir, 'viewer-app')

console.log('🔄 Syncing viewer files from main app to viewer-app...')

// Ensure directories exist
const dirsToCreate = [
  path.join(targetDir, 'src'),
  path.join(targetDir, 'src', 'components'),
  path.join(targetDir, 'src', 'lib'),
]

dirsToCreate.forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
})

// Files to copy directly
const filesToCopy = [
  { from: 'src/types.ts', to: 'src/types.ts' },
  { from: 'src/treeUtils.ts', to: 'src/treeUtils.ts' },
  { from: 'src/localDb.ts', to: 'src/localDb.ts' },
  { from: 'src/relationalAdapter.ts', to: 'src/relationalAdapter.ts' },
  { from: 'src/index.css', to: 'src/index.css' },
  { from: 'src/PrintableTribute.css', to: 'src/PrintableTribute.css' },
  { from: 'src/lib/supabase.ts', to: 'src/lib/supabase.ts' },
  { from: 'src/components/PublicViewerPortal.tsx', to: 'src/components/PublicViewerPortal.tsx' },
  { from: 'src/components/PublicViewerPortal.css', to: 'src/components/PublicViewerPortal.css' },
  { from: 'src/components/VisualTreeChart.tsx', to: 'src/components/VisualTreeChart.tsx' },
  { from: 'src/components/TreeWifePicker.tsx', to: 'src/components/TreeWifePicker.tsx' },
  { from: 'src/components/TreeWifePicker.css', to: 'src/components/TreeWifePicker.css' },
  { from: 'src/components/PrintableTributeView.tsx', to: 'src/components/PrintableTributeView.tsx' },
  { from: 'src/components/ViewerMobileApp.tsx', to: 'src/components/ViewerMobileApp.tsx' },
  { from: 'src/components/ViewerMobileApp.css', to: 'src/components/ViewerMobileApp.css' },
]

filesToCopy.forEach(({ from, to }) => {
  const srcPath = path.join(rootDir, from)
  const destPath = path.join(targetDir, to)
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath)
    console.log(`  ✓ Copied: ${from} -> ${to}`)
  } else {
    console.warn(`  ⚠️ Missing: ${from}`)
  }
})

console.log('✨ Sync complete!')
