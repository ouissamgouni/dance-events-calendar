import { test, expect } from '@playwright/test'

// Auth smoke test. Requires the backend running with DEV_AUTH=true
// (see docs/DEVELOPMENT_WORKFLOW.md — `task start`). When the backend is not
// in dev-auth mode the test self-skips so the shell smoke suite can still run.

test('dev sign-in redirects home and persists across reload', async ({ page }) => {
    await page.goto('/login')

    const devBanner = page.getByText(/Dev mode \(DEV_AUTH=true\)/i)
    if (!(await devBanner.isVisible().catch(() => false))) {
        test.skip(true, 'Backend is not running in DEV_AUTH mode')
    }

    await page.getByPlaceholder('user@example.com').fill('e2e-smoke@example.com')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    // Redirected away from /login once authenticated.
    await expect(page).toHaveURL(/\/(admin)?$/)
    await expect(page.getByRole('heading', { name: 'Sign in' })).toHaveCount(0)

    // Session cookie keeps the user authenticated after a reload.
    await page.reload()
    await expect(page).not.toHaveURL(/\/login/)
})
