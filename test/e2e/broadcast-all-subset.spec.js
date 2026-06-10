// Smoke test for /broadcast/all subset selection.
//
// The Control Room's "Audience broadcast — pick events…" chooser
// builds a /broadcast/all?ids=<csv> URL when the operator picks a
// strict subset of currently-Live events. This test mocks the
// /api/events response so we can verify the view honours that
// filter without spinning up real meets:
//
//   1. With ?ids=evt-2,evt-4  → only those two iframes render
//   2. With no ?ids=         → every Live event renders
//   3. With ?ids=<dead-id>   → "all selected events have finished"
//                              rescue UI appears
//
// The iframe src is asserted but the iframes are not waited on
// to load — the /scoreboard/<id>/broadcast view they would render
// is exercised separately.

const { test, expect } = require('@playwright/test')

const fakeEvents = [
  { id: 'evt-1', name: 'Womens 10m Platform', height: '10m', gender: 'F', status: 'Live' },
  { id: 'evt-2', name: 'Mens 3m Springboard', height: '3m',  gender: 'M', status: 'Live' },
  { id: 'evt-3', name: 'Womens 3m Synchro',  height: '3m',  gender: 'F', status: 'Live' },
  { id: 'evt-4', name: 'Mens 10m Synchro',   height: '10m', gender: 'M', status: 'Live' },
  // Completed event — should never appear in the grid regardless
  // of whether it's in ?ids=.
  { id: 'evt-5', name: 'Mixed Team Final',   height: 'team', gender: 'X', status: 'Completed' },
]

// Intercept /api/events with the fake list. Also stub the
// scoreboard broadcast URL each cell loads so the iframes don't
// stall waiting on real data.
async function installMocks(page) {
  await page.route('**/api/events*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fakeEvents),
    })
  })
  await page.route('**/scoreboard/*/broadcast', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!DOCTYPE html><html><body>stub</body></html>',
    })
  })
}

test('/broadcast/all?ids= filters to the chosen subset', async ({ page }) => {
  await installMocks(page)
  await page.goto('/broadcast/all?ids=evt-2,evt-4')

  // Wait for the loading state to clear.
  await expect(page.locator('.mbcast-grid')).toBeVisible({ timeout: 5000 })

  const frames = page.locator('.mbcast-frame')
  await expect(frames).toHaveCount(2)
  // The two we picked, in the order /api/events returns them.
  await expect(frames.nth(0)).toHaveAttribute('src', /\/scoreboard\/evt-2\/broadcast/)
  await expect(frames.nth(1)).toHaveAttribute('src', /\/scoreboard\/evt-4\/broadcast/)

  // The "operator-selected subset" badge tells viewers this is a
  // strict pick rather than "every Live event".
  await expect(page.locator('.mbcast-stat-sub')).toBeVisible()
})

test('/broadcast/all with no ids shows every Live event', async ({ page }) => {
  await installMocks(page)
  await page.goto('/broadcast/all')
  await expect(page.locator('.mbcast-grid')).toBeVisible({ timeout: 5000 })

  // 4 Live events in the fake list (the Completed one is filtered).
  await expect(page.locator('.mbcast-frame')).toHaveCount(4)
  // No subset badge when there is no ?ids= filter.
  await expect(page.locator('.mbcast-stat-sub')).toHaveCount(0)
})

test('/broadcast/all?ids=<dead-id> shows the rescue UI', async ({ page }) => {
  await installMocks(page)
  // evt-5 is Completed, evt-9 doesn't exist — both get filtered
  // out, leaving zero events in the picked subset.
  await page.goto('/broadcast/all?ids=evt-9,evt-5')

  // Rescue link is visible and offers a one-click jump back to
  // the "all Live events" view.
  await expect(page.getByText('All selected events have finished.')).toBeVisible({ timeout: 5000 })
  const rescue = page.getByRole('button', { name: /show all live events/i })
  await expect(rescue).toBeVisible()

  await rescue.click()
  // Clicking the rescue strips ?ids= from the URL; the grid
  // should now render every Live event.
  await expect(page).toHaveURL(/\/broadcast\/all$/)
  await expect(page.locator('.mbcast-frame')).toHaveCount(4)
})
