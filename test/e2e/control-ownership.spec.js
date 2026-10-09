// Real HTTP/socket ownership plus phone/tablet lifecycle, without scoring-rule changes.
const { test, expect } = require('@playwright/test');
const setup = require('./_setup');
const { signIn } = require('./_meetday');
const path = require('node:path');
const fs = require('node:fs');
const evidence = process.env.E2E_SHOT_DIR || path.join(process.cwd(), 'test-results', 'control-evidence');
function ask(socket, name, data) {
  return new Promise(resolve => socket.timeout(5000).emit(name, data, (error, reply) => resolve(error ? { ok: false, error: 'timeout' } : reply)));
}
async function fixture(request) {
  const org = await setup.createOrgAndAdmin(request);
  const event = await setup.createEvent(request, { adminToken: org.adminToken, name: 'Concurrent springboard', total_rounds: 2, number_of_judges: 5, height: '3m' });
  const diver = await setup.insertUser({ orgId: org.orgId, role: 'diver', fullName: 'First Diver' });
  const next = await setup.insertUser({ orgId: org.orgId, role: 'diver', fullName: 'Next Diver' });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: '101', position: 'B' });
  for (const d of [diver, next]) await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives: [{ round_number: 1, dive_id: diveId }] });
  await setup.setEventStatus(request, { adminToken: org.adminToken, eventId: event.id, status: 'Live' });
  return { ...org, event, diver, next, diveId };
}
test('same-account owners, HTTP finalise, safety hold and takeover are fenced by generation', async ({ request, baseURL }) => {
  const f = await fixture(request);
  const a = await setup.openSocket(baseURL, f.adminToken), b = await setup.openSocket(baseURL, f.adminToken);
  const headers = { Authorization: `Bearer ${f.adminToken}` };
  const status = (data) => request.put(`/api/events/${f.event.id}/status`, { headers, data });
  try {
    expect((await status({ status: 'Completed' })).status()).toBe(409);
    const first = await ask(a, 'claim_event_control', { event_id: f.event.id, protocol: 2 });
    expect(first.ok).toBe(true);
    expect((await ask(b, 'claim_event_control', { event_id: f.event.id.toUpperCase(), protocol: 2 })).error).toBe('control_conflict');
    expect((await status({ status: 'Completed' })).status()).toBe(409);
    const takeover = await ask(b, 'claim_event_control', { event_id: f.event.id, protocol: 2, takeover: true });
    expect(takeover.ok).toBe(true);
    expect((await status({ status: 'Completed', control_token: first.control_token })).status()).toBe(409);
    expect((await ask(a, 'set_active_diver', { event_id: f.event.id, control_token: first.control_token })).error).toBe('control_lost');
    expect((await ask(a, 'meet_hold', { event_id: f.event.id, reason: 'Referee check' })).ok).toBe(true);
    const held = await status({ status: 'Completed', control_token: takeover.control_token });
    expect(held.status()).toBe(409); expect((await held.json()).code).toBe('event_held');
    expect((await ask(a, 'meet_resume', { event_id: f.event.id })).ok).toBe(true);
    expect((await status({ status: 'Completed', control_token: takeover.control_token })).status()).toBe(200);
    expect((await ask(a, 'claim_event_control', { event_id: f.event.id, protocol: 2 })).error).toBe('event_not_live');
    expect((await ask(b, 'set_active_diver', { event_id: f.event.id, control_token: takeover.control_token })).error).toBe('event_not_live');
    const persisted = await setup.pool.query('SELECT * FROM event_live_state WHERE event_id=$1', [f.event.id]);
    expect(persisted.rows).toEqual([]);
  } finally { a.disconnect(); b.disconnect(); }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 1366 }]) {
  test(`control is explicit and returning from background requires restore and a stopped clock (${viewport.width})`, async ({ request, page, baseURL }) => {
    await page.setViewportSize(viewport);
    const f = await fixture(request);
    await signIn(page, f.username);
    await page.goto(`/control?event=${f.event.id}`);
    const card = page.locator(`.cv2-pool[data-event-id="${f.event.id}"]`);
    await expect(card.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
    await expect(card.locator('.cv2-primary')).toBeDisabled();
    await card.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Release control', exact: true })).toBeVisible();
    await expect(card.locator('.cv2-shotclock')).toHaveText('—');
    await card.getByRole('button', { name: 'Restart clock', exact: true }).click();
    await expect(card.locator('.cv2-shotclock')).toHaveText(/\d+s/);
    // A WebView background transition closes sockets; the web visibility
    // path must independently fence progression before the browser suspends.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(card.getByRole('button', { name: 'Take control', exact: true })).toBeVisible();
    await expect(card.locator('.cv2-shotclock')).toHaveText('—');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(card.locator('.cv2-primary')).toBeDisabled();
    const other = await setup.openSocket(baseURL, f.adminToken);
    try {
      expect((await ask(other, 'claim_event_control', { event_id: f.event.id, protocol: 2 })).ok).toBe(true);
      await card.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(card.getByRole('button', { name: 'Take over', exact: true })).toBeVisible();
      await card.getByRole('button', { name: 'Take over', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(f.event.name);
      await page.getByRole('dialog').getByRole('button', { name: 'Take over', exact: true }).click();
      await expect(card.getByRole('button', { name: 'Release control', exact: true })).toBeVisible();
      await expect(card.locator('.cv2-shotclock')).toHaveText('—');
      await expect(page.getByRole('dialog')).toBeHidden()
      await page.locator('.notify-bar-close').evaluateAll(buttons => buttons.forEach(button => button.click()))
      await expect(page.locator('.notify-bar')).toHaveCount(0)
      fs.mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, `control-ownership-${viewport.width}.png`), fullPage: true });
    } finally { other.disconnect(); }
  });
}

test('a withdrawn canonical current diver can be restored and skipped without resetting to the first diver', async ({ request, page, baseURL }) => {
  const f = await fixture(request);
  const socket = await setup.openSocket(baseURL, f.adminToken);
  const owned = await ask(socket, 'claim_event_control', { event_id: f.event.id, protocol: 2 });
  const roster = await request.get(`/api/events/${f.event.id}/roster`, { headers: { Authorization: `Bearer ${f.adminToken}` } });
  const row = (await roster.json()).find(r => r.competitor_id === f.diver.userId);
  expect((await ask(socket, 'set_active_diver', { ...row, control_token: owned.control_token })).ok).toBe(true);
  await ask(socket, 'release_event_control', { event_id: f.event.id, control_token: owned.control_token });
  socket.disconnect();
  await setup.pool.query('UPDATE competitor_dive_lists SET withdrawn_at=now() WHERE event_id=$1 AND competitor_id=$2', [f.event.id, f.diver.userId]);
  await signIn(page, f.username);
  await page.goto(`/control?event=${f.event.id}`);
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Release control', exact: true })).toBeVisible();
  await expect(page.locator('.cv2-live-diver')).toContainText('First Diver');
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Skip diver', exact: true }).click();
  await expect(page.locator('.cv2-live-diver')).toContainText('Next Diver');
});
