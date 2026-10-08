// Browser layout/interaction checks, not a claim of native OS verification.
// Identity/feature API fixtures isolate navigation permissions from the DB.
const { test, expect } = require('@playwright/test')

async function signedIn(page, roles = ['spectator'], extra = {}) {
  await page.addInitScript(() => {
    for (const role of ['coach', 'judge', 'diver']) localStorage.setItem(`dr_tour_seen_${role}`, '1')
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let body = []
    if (path === '/api/auth/me') body = { user: {
      id: '11111111-1111-4111-8111-111111111111', username: 'mobile-test',
      full_name: 'Mobile Test', org_roles: roles, is_system_admin: false,
      org_id: '22222222-2222-4222-8222-222222222222', ...extra,
    } }
    else if (path === '/api/features') body = { payments: false, classes: false, signups: true, maintenance: false }
    else if (path === '/api/push/vapid-public-key') body = { publicKey: null }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto('/inbox')
  await expect(page.locator('.app-shell')).toBeVisible()
}

for (const viewport of [
  { width: 390, height: 844 }, { width: 844, height: 390 },
  { width: 820, height: 1180 }, { width: 1180, height: 820 },
]) {
  test(`notification settings reachable with touch targets at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await signedIn(page)
    const navigation = viewport.width <= 860 ? page.getByRole('navigation', { name: 'App tabs' }) : page.getByRole('navigation', { name: 'Primary' })
    await navigation.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open notification inbox' })).toHaveAttribute('href', '/inbox')
    const content = page.locator('#main-content')
    expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    if (viewport.width <= 860) {
      const tabs = page.getByRole('navigation', { name: 'App tabs' })
      const box = await tabs.boundingBox()
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
      for (const item of await tabs.locator('a, button').all()) {
        expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44)
      }
      expect((await content.boundingBox()).y + (await content.boundingBox()).height).toBeLessThanOrEqual(box.y + 1)
    }
  })
}

for (const [role, target] of [
  ['spectator', '/scoreboard'], ['diver', '/competitor'], ['judge', '/judge'],
  ['coach', '/coach'], ['referee', '/control'], ['meet_manager', '/control'], ['org_admin', '/control'],
]) {
  test(`phone ${role} has its work shortcut and only permitted tools`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signedIn(page, [role])
    const tabs = page.getByRole('navigation', { name: 'App tabs' })
    await expect(tabs.locator(`a[href="${target}"]`)).toBeVisible()
    await tabs.getByRole('button', { name: 'Menu', exact: true }).click()
    const menu = page.getByRole('dialog', { name: 'App menu' })
    await expect(menu.locator(`a[href="${target}"]`)).toBeVisible()
    await expect(menu.locator('a[href="/payments"]')).toHaveCount(0)
    await expect(menu.locator('a[href="/classes"]')).toHaveCount(0)
    if (role !== 'org_admin') await expect(menu.locator('a[href="/users"]')).toHaveCount(0)
    if (!['org_admin', 'meet_manager', 'referee'].includes(role)) await expect(menu.locator('a[href="/control"]')).toHaveCount(0)
  })
}

test('delegate administrators retain club and region tools on phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signedIn(page, ['spectator'], { club_admin_of: ['33333333-3333-4333-8333-333333333333'], region_admin_of: ['44444444-4444-4444-8444-444444444444'] })
  await page.getByRole('navigation', { name: 'App tabs' }).getByRole('button', { name: 'Menu', exact: true }).click()
  const menu = page.getByRole('dialog', { name: 'App menu' })
  for (const path of ['/club', '/region', '/manager', '/control']) await expect(menu.locator(`a[href="${path}"]`)).toBeVisible()
})

test('phone menu filters tools, contains keyboard focus and restores it on close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signedIn(page)
  const opener = page.getByRole('navigation', { name: 'App tabs' }).getByRole('button', { name: 'Menu', exact: true })
  await opener.click()
  const menu = page.getByRole('dialog', { name: 'App menu' })
  await expect(page.locator('.shell-main')).toHaveAttribute('inert', '')
  const search = menu.getByRole('searchbox', { name: 'Find a tool' })
  await search.fill('settings')
  await expect(menu.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveCount(1)
  expect(await search.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await menu.locator('.sb-user').focus()
  await page.keyboard.press('Tab')
  await expect(menu.locator('.sb-brand')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
  await expect(page.locator('.shell-main')).not.toHaveAttribute('inert', '')
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '')
})

test('keyboard viewport keeps the app above the keyboard and restores tabs after dismissing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  // Model viewport geometry only. Real iOS/Android keyboard behavior remains
  // on the physical-device checklist.
  await page.addInitScript(() => {
    const viewport = new EventTarget()
    viewport.height = 844
    viewport.scale = 1
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  })
  await signedIn(page)
  await page.getByRole('navigation', { name: 'App tabs' }).getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Find a tool' }).focus()
  await page.evaluate(() => {
    window.visualViewport.height = 480
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await expect(page.locator('.app-shell')).toHaveClass(/keyboard-open/)
  expect(Math.round((await page.locator('.app-shell').boundingBox()).height)).toBe(480)
  await expect(page.locator('.mobile-tabs')).toHaveCount(0)
  await page.evaluate(() => {
    window.visualViewport.height = 844
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await page.getByRole('button', { name: 'Close menu' }).click()
  await expect(page.getByRole('navigation', { name: 'App tabs' })).toBeVisible()
  expect(Math.round((await page.locator('.app-shell').boundingBox()).height)).toBe(844)
})

test('a failed inbox read after sign-out does not toast on the login screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signedIn(page)
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings', exact: true }).click()
  let release
  const requested = new Promise(resolve => { release = resolve })
  let pendingRoute
  await page.route('**/api/notifications/me?limit=100', route => { pendingRoute = route; release() })
  await page.getByRole('link', { name: 'Open notification inbox' }).click()
  await requested
  await page.locator('.sb-user').click()
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  const response = page.waitForResponse(r => r.url().endsWith('/api/notifications/me?limit=100'))
  await pendingRoute.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' })
  await response
  // Let the rejected load and Vue render settle after the response arrives.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(page.getByText('Failed to load inbox: Not found', { exact: true })).toHaveCount(0)
})

test('a current inbox failure still shows an actionable error', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signedIn(page)
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings', exact: true }).click()
  await page.route('**/api/notifications/me?limit=100', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }))
  await page.getByRole('link', { name: 'Open notification inbox' }).click()
  await expect(page.getByText('Failed to load inbox: Not found', { exact: true })).toBeVisible()
})
