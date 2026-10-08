// Exercise actual env(safe-area-inset-*) values via Chromium's DevTools
// emulation. This verifies CSS geometry; native simulator screenshots remain
// the evidence for UIKit/WebView rendering.
const { test, expect } = require('@playwright/test')

async function fixtureApi(page) {
  let session = false
  const user = { id: '11111111-1111-4111-8111-111111111111', org_id: '22222222-2222-4222-8222-222222222222', full_name: 'Setup admin', username: 'setup-admin', org_roles: ['org_admin'], is_system_admin: false }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let body = []
    if (path === '/api/auth/login') { session = true; body = { user } }
    else if (path === '/api/auth/me') body = { user: session ? user : null }
    else if (path === '/api/features') body = { signups: true, payments: false, classes: false, maintenance: false }
    else if (path === '/api/auth/signups-status') body = { enabled: true }
    else if (path === '/api/push/vapid-public-key') body = { publicKey: null }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

for (const shape of [
  { name: 'portrait', width: 390, height: 844, insets: { top: 62, bottom: 34, left: 0, right: 0 } },
  { name: 'landscape', width: 844, height: 390, insets: { top: 0, bottom: 21, left: 59, right: 59 } },
]) {
  test(`sign in to setup clears ${shape.name} safe areas and fits all wizard steps`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: shape.width, height: shape.height })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: shape.insets })
    await fixtureApi(page)
    await page.goto('/login?next=/setup')
    await page.locator('input[autocomplete=username]').fill('setup-admin')
    await page.locator('input[autocomplete=current-password]').fill('unused-fixture-password')
    await page.locator('button[type=submit]').click()
    await page.waitForURL(/\/setup$/)
    const shell = page.locator('.wizard-shell')
    await expect(shell).toBeVisible()
    const logo = await page.locator('.wizard-logo').boundingBox()
    const skip = await page.locator('.wizard-skip-link').boundingBox()
    expect(logo.y).toBeGreaterThanOrEqual(shape.insets.top)
    expect(logo.x).toBeGreaterThanOrEqual(shape.insets.left)
    expect(skip.x + skip.width).toBeLessThanOrEqual(shape.width - shape.insets.right + 1)
    expect(await shell.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    for (let step = 0; step < 4; step++) {
      // Returning administrators may jump straight to any setup step.
      await page.locator('.wizard-step').nth(step).click()
      expect(await shell.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await expect(page.locator('.wizard-card')).toBeVisible()
    }
    await page.locator('.wizard-step').first().click()
    await shell.evaluate(el => { el.scrollTop = 0 })
    await page.screenshot({ path: testInfo.outputPath(`setup-${shape.name}-insets.png`), animations: 'disabled' })
    await testInfo.attach(`setup-${shape.name}`, { path: testInfo.outputPath(`setup-${shape.name}-insets.png`), contentType: 'image/png' })
  })
}

test('auth forms own their safe-area scroll layout without changing body', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 62, bottom: 34, left: 0, right: 0 } })
  await fixtureApi(page)
  for (const path of ['/login', '/register', '/register-org', '/forgot-password', '/reset-password', '/verify-email']) {
    await page.goto(path)
    const layout = page.locator('.auth-layout')
    await expect(layout).toBeVisible()
    const geometry = await layout.evaluate(el => ({
      top: parseFloat(getComputedStyle(el).paddingTop),
      bottom: parseFloat(getComputedStyle(el).paddingBottom),
      fits: el.scrollWidth <= el.clientWidth + 1,
      bodyDisplay: getComputedStyle(document.body).display,
    }))
    expect(geometry.top).toBeGreaterThanOrEqual(62)
    expect(geometry.bottom).toBeGreaterThanOrEqual(34)
    expect(geometry.fits, path).toBe(true)
    expect(geometry.bodyDisplay, path).not.toBe('flex')
  }
})
