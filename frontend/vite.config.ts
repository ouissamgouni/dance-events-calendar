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
  let publicDir = 'public'
  return {
    name: 'pwa-env-name',
    configResolved(config) {
      outDir = config.build.outDir
      publicDir = config.publicDir
    },
    // Dev server (scenarios): serve the patched manifest instead of the raw public/ copy.
    configureServer(server) {
      server.middlewares.use('/manifest.json', async (_req, res, next) => {
        try {
          const manifest = JSON.parse(await readFile(join(publicDir, 'manifest.json'), 'utf8'))
          manifest.name = appName
          manifest.short_name = appNameShort
          res.setHeader('Content-Type', 'application/manifest+json')
          res.end(JSON.stringify(manifest, null, 4))
        } catch {
          next()
        }
      })
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
  const viteProxyTarget = env.VITE_PROXY_TARGET || process.env.VITE_PROXY_TARGET || viteApiUrl
  const objectStorageProxyTarget = env.VITE_OBJECT_STORAGE_PROXY_TARGET || process.env.VITE_OBJECT_STORAGE_PROXY_TARGET
  const objectStorageBucket = env.VITE_OBJECT_STORAGE_BUCKET || process.env.VITE_OBJECT_STORAGE_BUCKET
  const objectStoragePrivateBucket = env.VITE_OBJECT_STORAGE_PRIVATE_BUCKET || process.env.VITE_OBJECT_STORAGE_PRIVATE_BUCKET
  const umamiProxyTarget = env.VITE_UMAMI_PROXY_TARGET || process.env.VITE_UMAMI_PROXY_TARGET
  const allowedHost = env.VITE_ALLOWED_HOST || process.env.VITE_ALLOWED_HOST
  const appName = env.VITE_APP_NAME || process.env.VITE_APP_NAME || 'Movida'
  const appNameShort = env.VITE_APP_NAME_SHORT || process.env.VITE_APP_NAME_SHORT || 'Movida'

  // Diagnostic for CI logs (Cloudflare) to confirm whether build-time env is present.
  console.log('[vite] VITE_API_URL detected:', viteApiUrl || '(empty)')
  console.log('[vite] VITE_APP_NAME detected:', appName)
  console.log('[vite] VITE_CARTO_BASEMAP_KEY detected:', (env.VITE_CARTO_BASEMAP_KEY || process.env.VITE_CARTO_BASEMAP_KEY) ? '(set)' : '(empty — OSM fallback)')
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
            if (/[\\/]node_modules[\\/](leaflet|leaflet\.markercluster|react-leaflet|@react-leaflet|maplibre-gl|@maplibre)[\\/]/.test(id)) {
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
      allowedHosts: allowedHost ? [allowedHost] : [],
      // Remote phone demo: the HMR socket drops while the PWA is backgrounded (camera) and Vite reloads on reconnect.
      ...(allowedHost ? { ws: false as const } : {}),
      proxy: {
        '/api': viteProxyTarget || 'http://localhost:8001',
        ...(objectStorageProxyTarget && objectStorageBucket ? {
          '/objects': {
            target: objectStorageProxyTarget,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/objects/, `/${objectStorageBucket}`),
          },
        } : {}),
        // Presigned URLs sign the endpoint host; changeOrigin keeps it intact.
        ...(objectStorageProxyTarget && objectStoragePrivateBucket ? {
          '/private-objects': {
            target: objectStorageProxyTarget,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/private-objects/, `/${objectStoragePrivateBucket}`),
          },
        } : {}),
        ...(umamiProxyTarget ? {
          '/umami': {
            target: umamiProxyTarget,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/umami/, ''),
          },
        } : {}),
      },
    },
  }
})
