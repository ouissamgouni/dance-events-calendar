import { defineConfig, devices } from '@playwright/test'

// E2E smoke tests. These exercise the app shell and a few critical journeys
// against the Vite dev server. Real-data journeys assume the backend is running
// with DEV_AUTH enabled (see docs/DEVELOPMENT_WORKFLOW.md and `task start`).
const PORT = 5173
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL,
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
})
