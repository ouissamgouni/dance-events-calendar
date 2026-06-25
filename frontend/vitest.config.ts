import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest configuration is kept separate from vite.config.ts so the app
// build (tsc -b && vite build) never pulls in test-only globals. The
// `__VITE_API_URL__` define mirrors the app define so api.ts resolves a
// deterministic base URL under test; MSW handlers match it with a
// wildcard origin so either branch of resolveApiBase() is intercepted.
export default defineConfig({
    plugins: [react()],
    define: {
        __VITE_API_URL__: JSON.stringify('http://localhost:8001'),
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        css: false,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        // Playwright e2e specs live under e2e/ and run with their own runner.
        exclude: ['node_modules', 'dist', 'e2e'],
        restoreMocks: true,
        clearMocks: true,
    },
})
