import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const viteApiUrl = env.VITE_API_URL || process.env.VITE_API_URL

  // Prevent broken deploys where Pages serves HTML for /api because VITE_API_URL is missing.
  if (command === 'build' && !viteApiUrl) {
    throw new Error(
      'Missing VITE_API_URL for build. Set it in Cloudflare Pages Environment Variables for both Preview and Production.',
    )
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        '/api': viteApiUrl || 'http://localhost:8001',
      },
    },
  }
})
