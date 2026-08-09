import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Rewrites the PWA display name per environment so staging installs are
// distinguishable from production on the device home screen. Patches the
// copied manifest on disk (public assets aren't part of the rollup bundle)
// and the iOS apple-mobile-web-app-title meta tag.
function pwaEnvName(appName: string, appNameShort: string): Plugin {
  let outDir = 'dist'
  return {
    name: 'pwa-env-name',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    transformIndexHtml(html) {
      return html.replace(
        /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
        `$1${appNameShort}$2`,
      )
    },
    async closeBundle() {
      const manifestPath = join(outDir, 'manifest.json')
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.name = appName
        manifest.short_name = appNameShort
        await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + '\n')
      } catch {
        // No manifest emitted (e.g. some test builds) — nothing to patch.
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const viteApiUrl = env.VITE_API_URL || process.env.VITE_API_URL
  const appName = env.VITE_APP_NAME || process.env.VITE_APP_NAME || 'Movida'
  const appNameShort = env.VITE_APP_NAME_SHORT || process.env.VITE_APP_NAME_SHORT || 'Movida'

  // Diagnostic for CI logs (Cloudflare) to confirm whether build-time env is present.
  console.log('[vite] VITE_API_URL detected:', viteApiUrl || '(empty)')
  console.log('[vite] VITE_APP_NAME detected:', appName)
  console.log('[vite] VITE_UMAMI_URL detected:', env.VITE_UMAMI_URL || process.env.VITE_UMAMI_URL || '(empty — Umami will be disabled)')
  console.log('[vite] VITE_UMAMI_WEBSITE_ID detected:', (env.VITE_UMAMI_WEBSITE_ID || process.env.VITE_UMAMI_WEBSITE_ID) ? '(set)' : '(empty — Umami will be disabled)')

  return {
    plugins: [react(), tailwindcss(), pwaEnvName(appName, appNameShort)],
    define: {
      __VITE_API_URL__: JSON.stringify(viteApiUrl || ''),
    },
    build: {
      rollupOptions: {
        output: {
          // Split large, rarely-changing vendor libraries into their own
          // long-cached chunks. Leaflet + FullCalendar are only needed by
          // the map / calendar views, so keeping them out of the entry
          // chunk shrinks the JS downloaded on first paint (LCP path).
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined
            if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
              return 'vendor-react'
            }
            if (/[\\/]node_modules[\\/](leaflet|leaflet\.markercluster|react-leaflet|@react-leaflet)[\\/]/.test(id)) {
              return 'vendor-leaflet'
            }
            if (/[\\/]node_modules[\\/]@fullcalendar[\\/]/.test(id)) {
              return 'vendor-fullcalendar'
            }
            return undefined
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': viteApiUrl || 'http://localhost:8001',
      },
    },
  }
})
