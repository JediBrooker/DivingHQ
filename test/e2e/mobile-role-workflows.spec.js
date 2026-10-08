// Populated screens, real test DB/auth/API, no production mutations.
const { test, expect } = require('@playwright/test')
const setup = require('./_setup')

test.describe.configure({ mode: 'serial' })
let scenario

test.beforeAll(async ({ request }) => {
  scenario = await setup.createEventScenario(request, {
    crossFederation: false,
    event: { name: 'Mobile device workflow event', total_rounds: 1, entries_close_at: new Date(Date.now() + 86400000).toISOString() },
    competitor: { fullName: 'Mobile diver Alexandra Montgomery' },
    coach: { fullName: 'Mobile coach' },
  })
})
test.afterAll(async () => { await scenario?.cleanup() })

async function login(page, username) {
  await setup.bypassRoleTour(page)
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('input[autocomplete="username"]').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL(/\/dashboard$/)
}
async function fits(page, label, testInfo) {
  const main = page.locator('#main-content')
  const metrics = await main.evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth }))
  expect(metrics.scroll, `${label} does not push the phone viewport sideways`).toBeLessThanOrEqual(metrics.width + 1)
  await page.screenshot({ path: testInfo.outputPath(`${label}.png`), fullPage: true, animations: 'disabled' })
  await testInfo.attach(label, { path: testInfo.outputPath(`${label}.png`), contentType: 'image/png' })
}
for (const viewport of [{ width: 390, height: 844 }, { width: 1180, height: 820 }]) {
  test(`manager and federation members populated at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await login(page, scenario.hostOrg.username)
    await page.goto('/manager')
    await page.getByRole('button', { name: /Your events|All events/i }).first().click()
    const row = page.locator('.event-item', { hasText: 'Mobile device workflow event' })
    await expect(row).toBeVisible()
    await fits(page, `manager-${viewport.width}`, testInfo)
    await row.locator('.dropdown-host button', { hasText: '⋯' }).first().click()
    await expect(row.locator('.event-overflow-menu')).toBeVisible()
    const menu = await row.locator('.event-overflow-menu').boundingBox()
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width + 1)
    await page.goto('/users')
    await expect(page.getByText('Mobile diver Alexandra Montgomery', { exact: true }).first()).toBeVisible()
    await fits(page, `members-${viewport.width}`, testInfo)
    if (viewport.width <= 600) {
      const member = page.locator('.user-row', { hasText: 'Mobile diver Alexandra Montgomery' })
      await expect(page.getByText('Select all visible members', { exact: true })).toBeVisible()
      expect(await member.evaluate(el => getComputedStyle(el).display)).toBe('grid')
      await member.getByRole('checkbox', { name: 'Select Mobile diver Alexandra Montgomery', exact: true }).check()
      await expect(page.locator('.bulk-count')).toContainText('1')
      await page.getByRole('checkbox', { name: 'Select all visible members', exact: true }).check()
      await expect(page.locator('.bulk-count')).toContainText('3')
      await page.getByRole('checkbox', { name: 'Select all visible members', exact: true }).uncheck()
      await expect(page.locator('.bulk-bar')).toHaveCount(0)
      await member.getByRole('button', { name: 'Mobile diver Alexandra Montgomery', exact: true }).click()
      const drawer = page.locator('.drawer')
      await expect(drawer).toBeVisible()
      // Vue's enter transition starts outside the viewport; visibility alone
      // still passes while the drawer is offscreen. Wait for usable geometry.
      await expect.poll(async () => Math.abs((await drawer.boundingBox()).x)).toBeLessThanOrEqual(1)
      await expect(drawer.locator('.profile-editor input[type=text]').first()).toHaveValue('Mobile diver Alexandra Montgomery')
      await expect(drawer.getByRole('button', { name: 'Save details', exact: true })).toBeInViewport()
      expect((await drawer.boundingBox()).width).toBeLessThanOrEqual(viewport.width)
      await page.screenshot({ path: testInfo.outputPath('member-details-phone.png'), animations: 'disabled' })
    }
  })
  test(`coach roster and diver sheet populated at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await login(page, scenario.coach.username)
    await page.goto('/coach')
    await expect(page.getByText('Mobile diver Alexandra Montgomery', { exact: true }).first()).toBeVisible()
    await fits(page, `coach-${viewport.width}`, testInfo)
    const name = page.locator('.diver-card-name').first()
    expect(await name.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    // Separate authenticated role, retaining browser layout/viewport settings.
    await login(page, scenario.competitor.username)
    await page.goto('/competitor')
    await page.locator('select').first().selectOption(scenario.event.id)
    await expect(page.getByText('101B', { exact: false }).first()).toBeVisible()
    await fits(page, `diver-${viewport.width}`, testInfo)
  })
}
