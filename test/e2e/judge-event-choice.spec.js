// Simultaneous assignments must never turn a reconnect replay into an
// implicit panel choice. Exercise real rooms, durable scores, and stale links.
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const setup = require('./_setup');
const { signIn, liveEvent, emitAck, trackSockets } = require('./_meetday');

test.describe.configure({ mode: 'serial' });

async function panels(request, baseURL) {
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request, { countryCode: 'AUS', orgName: 'Concurrent Judge' });
  const A = await liveEvent(request, { orgId, adminToken, name: 'Open 3m', diverNames: ['First Pool Diver'] });
  const B = await setup.createEvent(request, { adminToken, name: 'Open 3m', total_rounds: 1 });
  await setup.assignJudges(request, { adminToken, eventId: B.id, judgeIds: A.judges.map((j) => j.userId) });
  const second = await setup.insertUser({ orgId, role: 'diver', fullName: 'Second Pool Diver' });
  await setup.insertDiveList({ eventId: B.id, competitorId: second.userId, dives: [{ round_number: 1, dive_id: A.diveId }] });
  await setup.setEventStatus(request, { adminToken, eventId: B.id, status: 'Live' });
  for (const [event, name] of [[A.event, 'Morning Meet'], [B, 'Afternoon Meet']]) {
    const meet = await setup.pool.query('INSERT INTO meets (org_id, name) VALUES ($1, $2) RETURNING id', [orgId, name]);
    await setup.pool.query('UPDATE events SET meet_id = $1 WHERE id = $2', [meet.rows[0].id, event.id]);
  }
  function diver(event, user, name) {
    return { event_id: event.id, competitor_id: user.userId, round_number: 1, full_name: name,
      diverName: name, eventName: event.name, dive_id: A.diveId, dive_code: '101', position: 'B', dd: 1.5, number_of_judges: 5 };
  }
  const first = diver(A.event, A.divers[0], 'First Pool Diver');
  const next = diver(B, second, 'Second Pool Diver');
  expect(await emitAck(baseURL, adminToken, 'set_active_diver', first)).toMatchObject({ ok: true });
  expect(await emitAck(baseURL, adminToken, 'set_active_diver', next)).toMatchObject({ ok: true });
  return { orgId, adminToken, A, B, first, next };
}

async function context(browser, width = 390, height = 664) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true });
  const page = await ctx.newPage();
  await setup.bypassRoleTour(page);
  await trackSockets(page);
  return { ctx, page };
}
async function dismissNotices(page) {
  while (await page.locator('.notif-dismiss').count()) await page.locator('.notif-dismiss').first().click();
}
async function shot(page, name) {
  if (process.env.E2E_SHOT_DIR) await page.screenshot({ path: path.join(process.env.E2E_SHOT_DIR, name + '.png'), animations: 'disabled' });
}
async function routed(page, path) {
  await page.evaluate((to) => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(to), path);
}

test('several live panels require a choice; reconnects and other-event scores cannot replace it', async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const p = await panels(request, baseURL);
  const { ctx, page } = await context(browser);
  try {
    await signIn(page, p.A.judges[0].username);
    await page.goto('/judge');
    const chooser = page.getByTestId('judge-event-choices');
    await expect(chooser).toBeVisible();
    await dismissNotices(page);
    await expect(chooser).toContainText('Morning Meet');
    await expect(chooser).toContainText('Afternoon Meet');
    await expect(page.locator('.keypad')).toHaveCount(0);
    await expect(page.locator('.judge-layout')).not.toContainText('Pool Diver');
    await shot(page, 'judge-chooser-phone');
    await page.setViewportSize({ width: 820, height: 1180 });
    await shot(page, 'judge-chooser-tablet');
    await page.setViewportSize({ width: 390, height: 664 });
    await page.evaluate(() => window.__sockets.forEach((socket) => socket.close()));
    await expect(page.locator('.status-dot.connected')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/judge$/);
    await expect(chooser).toBeVisible();
    await chooser.locator(`[data-event-id="${p.A.event.id}"]`).click();
    await expect(page.locator('.diver-name')).toContainText('First Pool Diver');
    await expect(page.locator('.judge-id')).toContainText('J1');
    await page.locator('.keypad .key').filter({ hasText: /^7$/ }).click();
    await page.locator('.submit-btn').click();
    await expect(page.locator('.judge-panel-tile.mine')).toContainText('7.0');
    await expect(page.getByRole('button', { name: 'Switch event', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Switch event', exact: true }).click();
    await chooser.locator(`[data-event-id="${p.B.id}"]`).click();
    await expect(page.locator('.diver-name')).toContainText('Second Pool Diver');
    await expect(page.locator('.score-number')).toHaveText('0');
    await expect(page.locator('.judge-panel-tile.mine')).not.toContainText('7.0');
    // The singleton still belongs to the old room. Its new score and
    // hold broadcasts must not contaminate the newly selected panel.
    expect(await emitAck(baseURL, p.A.judges[1].token, 'submit_score', { ...p.first, judge_id: p.A.judges[1].userId, judge_number: 2, score: 9 })).toMatchObject({ ok: true });
    expect(await emitAck(baseURL, p.adminToken, 'meet_hold', { event_id: p.A.event.id, reason: 'Other pool paused' })).toMatchObject({ ok: true });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page).toHaveURL(new RegExp(p.B.id));
    await expect(page.locator('.hold-banner')).toHaveCount(0);
    await expect(page.locator('.judge-panel-tile.in')).toHaveCount(0);
    await page.locator('.keypad .key').filter({ hasText: /^8$/ }).click();
    await page.locator('.submit-btn').click();
    await expect(page.locator('.judge-panel-tile.mine')).toContainText('8.0');
    const scores = await setup.pool.query('SELECT event_id, score::float FROM scores WHERE judge_id = $1 ORDER BY score', [p.A.judges[0].userId]);
    expect(scores.rows).toEqual([{ event_id: p.A.event.id, score: 7 }, { event_id: p.B.id, score: 8 }]);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(p.B.id));
    await expect(page.locator('.judge-panel-tile.mine')).toContainText('8.0');
  } finally { try { await ctx.close(); } finally { await setup.deleteOrg(p.orgId); } }
});

test('an explicit unassigned event never accepts a replay and offers only this judge’s panels', async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const p = await panels(request, baseURL);
  const other = await setup.createOrgAndAdmin(request, { countryCode: 'NZL', orgName: 'Other Judge Org' });
  const foreign = await liveEvent(request, { ...other, name: 'Private Other Panel', diverNames: ['Other Org Diver'] });
  const { ctx, page } = await context(browser);
  try {
    await signIn(page, p.A.judges[0].username);
    await page.goto(`/judge?event=${foreign.event.id}`);
    await expect(page.getByRole('alert')).toContainText('You are not assigned');
    await dismissNotices(page);
    await expect(page.locator('.submit-btn')).toBeDisabled();
    await expect(page.locator('.judge-layout')).not.toContainText('Other Org Diver');
    await page.getByRole('button', { name: 'Switch event', exact: true }).click();
    await expect(page.getByTestId('judge-event-choices').locator('[data-event-id]')).toHaveCount(2);
    await expect(page.getByTestId('judge-event-choices')).not.toContainText('Private Other Panel');
    await page.getByTestId('judge-event-choices').locator(`[data-event-id="${p.B.id}"]`).click();
    await expect(page.locator('.diver-name')).toContainText('Second Pool Diver');
  } finally { await ctx.close(); await setup.deleteOrg(p.orgId); await setup.deleteOrg(other.orgId); }
});

test('a queued offline score prevents both button and URL switches until acknowledged', async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const p = await panels(request, baseURL);
  const { ctx, page } = await context(browser);
  try {
    await signIn(page, p.A.judges[0].username);
    await page.goto(`/judge?event=${p.A.event.id}`);
    await expect(page.locator('.diver-name')).toContainText('First Pool Diver');
    await expect(page.locator('.judge-id')).toContainText('J1');
    await dismissNotices(page);
    await ctx.setOffline(true);
    await page.evaluate(() => window.__sockets.forEach((socket) => socket.close()));
    await expect(page.locator('.status-dot.connected')).toHaveCount(0);
    await page.locator('.keypad .key').filter({ hasText: /^6$/ }).click();
    await page.locator('.submit-btn').click();
    const change = page.getByRole('button', { name: 'Switch event', exact: true });
    await expect(change).toBeDisabled();
    await expect(page.locator('.queued-strip')).toContainText('6.0');
    await routed(page, `/judge?event=${p.B.id}`);
    await expect(page).toHaveURL(new RegExp(p.A.event.id));
    await expect(page.locator('.diver-name')).toContainText('First Pool Diver');
    await ctx.setOffline(false);
    await expect(change).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('.judge-panel-tile.mine')).toContainText('6.0');
    await change.click();
    await page.getByTestId('judge-event-choices').locator(`[data-event-id="${p.B.id}"]`).click();
    await expect(page.locator('.diver-name')).toContainText('Second Pool Diver');
    await expect(page.locator('.score-number')).toHaveText('0');
    const rows = await setup.pool.query('SELECT event_id, score::float FROM scores WHERE judge_id = $1', [p.A.judges[0].userId]);
    expect(rows.rows).toEqual([{ event_id: p.A.event.id, score: 6 }]);
  } finally { await ctx.setOffline(false); await ctx.close(); await setup.deleteOrg(p.orgId); }
});

test('an Upcoming link cannot replay a stale dive, and changing live options does not choose for the judge', async ({ browser, request, baseURL }) => {
  test.setTimeout(90_000);
  const p = await panels(request, baseURL);
  await setup.setEventStatus(request, { adminToken: p.adminToken, eventId: p.A.event.id, status: 'Upcoming' });
  const { ctx, page } = await context(browser);
  try {
    await signIn(page, p.A.judges[0].username);
    await page.goto(`/judge?event=${p.A.event.id}`);
    await expect(page.locator('.event-name')).toContainText('Open 3m');
    await dismissNotices(page);
    await expect(page.locator('.diver-name')).not.toContainText('First Pool Diver');
    await expect(page.locator('.submit-btn')).toBeDisabled();
    await page.getByRole('button', { name: 'Switch event', exact: true }).click();
    await page.getByTestId('judge-event-choices').locator(`[data-event-id="${p.B.id}"]`).click();
    await expect(page.locator('.diver-name')).toContainText('Second Pool Diver');
    await setup.setEventStatus(request, { adminToken: p.adminToken, eventId: p.A.event.id, status: 'Live' });
    await expect(page.getByRole('button', { name: 'Switch event', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(p.B.id));
    await page.goto('/judge');
    const chooser = page.getByTestId('judge-event-choices');
    await expect(chooser.locator('[data-event-id]')).toHaveCount(2);
    await dismissNotices(page);
    await setup.setEventStatus(request, { adminToken: p.adminToken, eventId: p.B.id, status: 'Completed' });
    await expect(chooser.locator('[data-event-id]')).toHaveCount(1);
    await expect(page).toHaveURL(/\/judge$/);
    await expect(page.locator('.keypad')).toHaveCount(0);
    await chooser.locator(`[data-event-id="${p.A.event.id}"]`).click();
    await expect(page.locator('.diver-name')).toContainText('First Pool Diver');
  } finally { try { await ctx.close(); } finally { await setup.deleteOrg(p.orgId); } }
});
