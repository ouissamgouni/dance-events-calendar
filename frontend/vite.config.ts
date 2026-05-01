import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const viteApiUrl = env.VITE_API_URL || process.env.VITE_API_URL

  // Diagnostic for CI logs (Cloudflare) to confirm whether build-time env is present.
  console.log('[vite] VITE_API_URL detected:', viteApiUrl || '(empty)')

  return {
    plugins: [react(), tailwindcss()],
    define: {
      __VITE_API_URL__: JSON.stringify(viteApiUrl || ''),
    },
    server: {
      port: 5173,
      proxy: {
        '/api': viteApiUrl || 'http://localhost:8001',
      },
    },
  }
})
