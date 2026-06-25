import { test, expect } from '@playwright/test'

// App-shell smoke tests. These do NOT require the backend — they exercise the
// static shell and navigation, which render regardless of whether the events
// API is reachable. The "Suggest an event" modal flow is covered in depth by
// the Vitest component test (SuggestEventModal.test.tsx).

test('home renders the app shell', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Movida' }).first()).toBeVisible()
})

test('privacy page is reachable', async ({ page }) => {
    await page.goto('/privacy')
    await expect(page.getByText(/Movida/i).first()).toBeVisible()
})

test('login page renders', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})
