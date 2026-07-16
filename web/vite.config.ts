import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.FOLIO_PORT ?? '4780'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.FOLIO_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/uploads': `http://localhost:${apiPort}`,
    },
  },
})
