import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8767' }
  },
  build: {
    rollupOptions: { input: { legacy: 'index.html', browser: 'browser.html', studio: 'studio.html' } },
  },
})
