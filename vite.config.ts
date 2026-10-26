import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Support both the existing Vite names and the NEXT_PUBLIC_* names that are
  // already configured in the deployment environment.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})
