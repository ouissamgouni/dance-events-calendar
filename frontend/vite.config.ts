import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const viteApiUrl = env.VITE_API_URL || process.env.VITE_API_URL

  // Diagnostic for CI logs (Cloudflare) to confirm whether build-time env is present.
  console.log('[vite] VITE_API_URL detected:', viteApiUrl || '(empty)')
  console.log('[vite] VITE_UMAMI_URL detected:', env.VITE_UMAMI_URL || process.env.VITE_UMAMI_URL || '(empty — Umami will be disabled)')
  console.log('[vite] VITE_UMAMI_WEBSITE_ID detected:', (env.VITE_UMAMI_WEBSITE_ID || process.env.VITE_UMAMI_WEBSITE_ID) ? '(set)' : '(empty — Umami will be disabled)')

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
