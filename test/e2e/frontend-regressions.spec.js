// Regression checks for a sweep of frontend bugs (the A6-* list): the
// signed-in SPA outside the Control Room. Each test names the bug it
// pins and drives the screen the way a person would, so it fails on the
// old behaviour, not just on a changed implementation.
//
// Every test builds its own throwaway org and tears it down, so they're
// safe to run in parallel with the rest of the suite.

const { test, expect } = require("@playwright/test");
const speakeasy = require("speakeasy");
const setup = require("./_setup");

// Browser session via the API: page.request shares the page's cookie
// jar, so the SPA boots signed in without driving the login form.
async function signIn(page, username) {
  const r = await page.request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  expect(r.status(), await r.text()).toBe(200);
}

// Keep the first-login tour and the org-admin setup wizard out of the way.
async function quiet(page) {
  await setup.bypassRoleTour(page);
  await page.addInitScript(() => {
    try { localStorage.setItem("setup.wizardDismissed.v1", "1"); } catch { /* ignore */ }
  });
}

// Record every WebSocket the page opens, so a test can close them (to
// force a reconnect) or check none were left open.
async function trackSockets(page) {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
      }
    };
  });
}

async function openSocketCount(page) {
  return page.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).length);
}

async function withOrg(request, fn, opts) {
  const org = await setup.createOrgAndAdmin(request, opts);
  try {
    return await fn(org);
  } finally {
    await setup.pool.query("DELETE FROM events WHERE org_id = $1", [org.orgId]).catch(() => {});
    await setup.pool.query("DELETE FROM meets WHERE org_id = $1", [org.orgId]).catch(() => {});
    await setup.deleteOrg(org.orgId).catch(() => {});
  }
}

async function addNotification(userId, title, body = "Private note") {
  await setup.pool.query(
    `INSERT INTO notifications (user_id, category, title, body, status, sent_at)
     VALUES ($1, 'role_request', $2, $3, 'sent', now())`,
    [userId, title, body],
  );
}

async function signOutFromMenu(page) {
  await page.locator(".sb-user").click();
  await page.locator(".sb-menu-item.danger").click();
  await page.waitForURL(/\/login/);
}

// ---------------------------------------------------------------------
// A6-01: a 401 that means "wrong password" must not end the session.
// ---------------------------------------------------------------------
test("A6-01 a wrong current password on the profile page doesn't sign the user out", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Pat Typo" });
    await quiet(page);
    await signIn(page, diver.username);
    await page.goto("/profile");
    await page.getByRole("button", { name: "Change Password" }).click();
    const modal = page.locator(".modal").filter({ hasText: "Change Password" });
    await modal.locator('input[autocomplete="current-password"]').fill("WRONG-password-123");
    await modal.locator('input[autocomplete="new-password"]').nth(0).fill("Another-pass-5678!");
    await modal.locator('input[autocomplete="new-password"]').nth(1).fill("Another-pass-5678!");
    await modal.getByRole("button", { name: "Save Password" }).click();
    await expect(modal.locator(".msg-error")).toContainText(/incorrect/i);
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe("/profile");
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);
  });
});

// ---------------------------------------------------------------------
// A6-29: disabling 2FA ends the session; say so instead of bouncing.
// ---------------------------------------------------------------------
test("A6-29 disabling 2FA explains the sign-out before going to /login", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Tess Factor" });
    const { token } = await setup.loginAs(request, diver.username);
    const auth = { Authorization: `Bearer ${token}` };
    const tfa = await (await request.post("/api/auth/2fa/setup", { headers: auth })).json();
    const code = speakeasy.totp({ secret: tfa.base32, encoding: "base32" });
    expect((await request.post("/api/auth/2fa/confirm", { headers: auth, data: { code } })).status()).toBe(200);

    // Browser session through the second factor, with a recovery code.
    const step1 = await (await page.request.post("/api/auth/login", {
      data: { username: diver.username, password: setup.TEST_PASSWORD },
    })).json();
    expect(step1.needs_totp).toBe(true);
    const step2 = await page.request.post("/api/auth/login/totp", {
      data: { totp_token: step1.totp_token, code: tfa.recovery_codes[0] },
    });
    expect(step2.status()).toBe(200);

    await quiet(page);
    await page.goto("/profile");
    await page.getByRole("button", { name: /Two-Factor Auth/ }).click();
    const modal = page.locator(".tfa-modal");
    await expect(modal.getByText("ENABLED")).toBeVisible();
    await modal.getByRole("button", { name: "Disable 2FA" }).click();
    await modal.locator('input[type="password"]').fill(setup.TEST_PASSWORD);
    await modal.getByPlaceholder("123456 or abcde-12345").fill(tfa.recovery_codes[1]);
    await modal.getByRole("button", { name: "Disable 2FA" }).click();

    await expect(modal.getByText(/2FA disabled\. Sign in again/)).toBeVisible();
    await page.waitForTimeout(800);
    expect(new URL(page.url()).pathname, "still on the profile long enough to read it").toBe("/profile");
    await page.waitForURL(/\/login/, { timeout: 6000 });
  });
});

// ---------------------------------------------------------------------
// A6-04 + A6-07: the User Manager drawer.
// ---------------------------------------------------------------------
test("A6-04 Enter on the confirm dialog's Cancel button cancels", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const target = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Confirm Target" });
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/users");
    await page.locator("tr.user-row", { hasText: "Confirm Target" }).locator("td").nth(1).click();
    await page.getByRole("button", { name: "Suspend account" }).click();
    const dialog = page.locator(".confirm-backdrop");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Cancel");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(300);
    const r = await setup.pool.query("SELECT suspended_at FROM users WHERE id = $1", [target.userId]);
    expect(r.rows[0].suspended_at).toBeNull();

    // And focus can't Tab out of the dialog to the page behind it.
    await page.getByRole("button", { name: "Suspend account" }).click();
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".confirm-modal"))).toBe(true);
    await page.keyboard.press("Escape");
  });
});

test("A6-07 the User Manager drawer shows a user's DOB and can save their details", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Dana Birthday" });
    await setup.pool.query("UPDATE users SET date_of_birth = '2006-06-11' WHERE id = $1", [diver.userId]);
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/users");
    await page.locator("tr.user-row", { hasText: "Dana Birthday" }).locator("td").nth(1).click();
    await expect(page.locator('input[type="date"]')).toHaveValue("2006-06-11");
    await page.locator(".profile-editor .field").first().locator("input").fill("Dana Birthday-Smith");
    await page.getByRole("button", { name: "Save details" }).click();
    await expect(page.locator(".profile-save-row .club-status-saved")).toBeVisible();
    const r = await setup.pool.query(
      "SELECT full_name, to_char(date_of_birth, 'YYYY-MM-DD') AS dob FROM users WHERE id = $1",
      [diver.userId],
    );
    expect(r.rows[0]).toEqual({ full_name: "Dana Birthday-Smith", dob: "2006-06-11" });
  });
});

// ---------------------------------------------------------------------
// A6-05: the offline banner has to actually show.
// ---------------------------------------------------------------------
test("A6-05 the offline banner shows when the connection drops", async ({ page, request, context }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Olly Offline" });
    await quiet(page);
    await trackSockets(page);
    await signIn(page, diver.username);
    await page.goto("/competitor");
    await expect.poll(() => openSocketCount(page)).toBeGreaterThan(0);
    await context.setOffline(true);
    try {
      await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
      await expect(page.locator(".offline-banner")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".offline-banner")).toContainText(/Offline/);
    } finally {
      await context.setOffline(false);
    }
  });
});

// With the banner back, an action that failed days ago would pin it up
// for good: nothing ever ran the outbox's gc(), so finished entries past
// the 72h retention never left IndexedDB. A recent failure still shows.
test("A6-05 a failure past the retention window doesn't keep the banner up", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Gary Garbage" });
    await quiet(page);
    await signIn(page, diver.username);
    await page.goto("/competitor");
    await expect(page.locator(".offline-banner")).toHaveCount(0);

    const seed = async (entries) => page.evaluate((rows) => new Promise((resolve, reject) => {
      const req = indexedDB.open("divinghq-outbox");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction("outbox", "readwrite");
        for (const r of rows) tx.objectStore("outbox").put(r);
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }), entries);
    const entry = (key, ageMs) => {
      const at = new Date(Date.now() - ageMs).toISOString();
      return {
        idempotency_key: key, action_type: "submit_score", payload: {},
        actor_local_time: at, user_fingerprint: diver.userId.slice(0, 24),
        status: "failed", attempts: 5, last_attempt_at: at, last_error: "rejected",
        conflict_info: null, created_at: at, synced_at: null, server_response: null,
      };
    };
    const old = `b6-old-${diver.userId}`;
    await seed([entry(old, 4 * 24 * 3600 * 1000)]);
    await page.reload();
    await expect(page.locator(".page-header")).toBeVisible();
    // Give the startup scan its moment; the banner renders off it.
    await page.waitForTimeout(500);
    await expect(page.locator(".offline-banner")).toHaveCount(0);
    const left = await page.evaluate((key) => new Promise((resolve) => {
      const req = indexedDB.open("divinghq-outbox");
      req.onsuccess = () => {
        const get = req.result.transaction("outbox").objectStore("outbox").get(key);
        get.onsuccess = () => { req.result.close(); resolve(!!get.result); };
      };
    }), old);
    expect(left, "the stale entry is gone from IndexedDB").toBe(false);

    await seed([entry(`b6-new-${diver.userId}`, 60 * 60 * 1000)]);
    await page.reload();
    await expect(page.locator(".offline-banner")).toContainText("1 failed");
    await expect(page.getByTestId("offline-banner-retry")).toBeVisible();
  });
});

// ---------------------------------------------------------------------
// A6-06 + A6-24: sign-out on a shared laptop.
// ---------------------------------------------------------------------
test("A6-06 signing out takes the previous user's notification banners with it", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await addNotification(org.adminId, "B6 probe: your payment receipt");
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/dashboard");
    await expect(page.locator(".notif-card", { hasText: "B6 probe: your payment receipt" })).toBeVisible();
    await signOutFromMenu(page);
    await page.waitForTimeout(300);
    await expect(page.locator(".notif-card")).toHaveCount(0);
  });
});

test("A6-24 signing out closes the previous user's socket", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await quiet(page);
    await trackSockets(page);
    await signIn(page, org.username);
    await page.goto("/dashboard");
    await expect.poll(() => openSocketCount(page)).toBeGreaterThan(0);
    await signOutFromMenu(page);
    await expect.poll(
      () => page.evaluate(() => window.__sockets.filter((s) => s.readyState !== 3).length),
      { timeout: 8000 },
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------
// A6-19: marking read in the Inbox takes the banners down too.
// ---------------------------------------------------------------------
test("A6-19 'Mark all read' in the Inbox removes the floating banners", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await addNotification(org.adminId, "Inbox probe one");
    await addNotification(org.adminId, "Inbox probe two");
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/inbox");
    await expect(page.locator(".notif-card")).toHaveCount(2);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.locator(".notif-card")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------
// A6-08, A6-18, A6-21: the coach screens.
// ---------------------------------------------------------------------
test("A6-08 the coach dashboard rejoins its event rooms after a reconnect", async ({ page, request }) => {
  const scenario = await setup.createEventScenario(request);
  try {
    const frames = [];
    page.on("websocket", (ws) => ws.on("framesent", (f) => frames.push(String(f.payload))));
    await quiet(page);
    await trackSockets(page);
    await signIn(page, scenario.coach.username);
    await page.goto("/coach");
    const joined = () => frames.some((f) => f.includes("subscribe_event") && f.includes(scenario.event.id));
    await expect.poll(joined, { timeout: 10_000 }).toBe(true);

    frames.length = 0;
    await page.evaluate(() => window.__sockets.forEach((s) => s.close()));
    await expect.poll(joined, { timeout: 15_000 }).toBe(true);
  } finally {
    await scenario.cleanup();
  }
});

test("A6-18 the coach dive-list page follows the UI language", async ({ page, request }) => {
  const scenario = await setup.createEventScenario(request);
  try {
    await quiet(page);
    await page.addInitScript(() => {
      try { localStorage.setItem("locale", "fr"); } catch { /* ignore */ }
    });
    await signIn(page, scenario.coach.username);
    await page.goto(`/coach/dive-lists/${scenario.event.id}`);
    await expect(page.locator(".page-label")).toHaveText("Entraîneur → Listes de plongeons");
    await expect(page.getByText("Scenario Diver")).toBeVisible();
    await expect(page.getByText("Not submitted")).toHaveCount(0);
  } finally {
    await scenario.cleanup();
  }
});

test("A6-21 the coach alerts panel only offers push where it can work", async ({ page, request }) => {
  const scenario = await setup.createEventScenario(request);
  try {
    await quiet(page);
    await signIn(page, scenario.coach.username);
    await page.goto("/coach");
    await page.getByRole("button", { name: /Alerts (on|off)/ }).click();
    await expect(page.locator(".alert-settings-panel")).toBeVisible();
    // http://127.0.0.1 can't do web push at all.
    await expect(page.getByRole("button", { name: "Enable push on this device" })).toHaveCount(0);
  } finally {
    await scenario.cleanup();
  }
});

// ---------------------------------------------------------------------
// A6-09 + A6-10: guardian links, request and approval.
// ---------------------------------------------------------------------
test("A6-09/A6-10 a parent can find their child and an admin can approve the link", async ({ page, browser, request }) => {
  await withOrg(request, async (org) => {
    const parent = await setup.insertUser({ orgId: org.orgId, role: "spectator", fullName: "Gwen Guardian" });
    const child = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Kiddo Lindqvist" });
    await setup.pool.query("UPDATE users SET date_of_birth = '2014-05-05' WHERE id = $1", [child.userId]);

    await quiet(page);
    await signIn(page, parent.username);
    await page.goto("/guardians");
    await page.locator(".gv-page input.input").fill("Lindqvist");
    const hit = page.locator(".gv-result-item", { hasText: "Kiddo Lindqvist" });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.locator(".notify-bar-error")).toHaveCount(0);
    await expect.poll(async () => (await setup.pool.query(
      "SELECT status FROM guardians WHERE guardian_user_id = $1 AND dependent_user_id = $2",
      [parent.userId, child.userId],
    )).rows[0]?.status).toBe("pending");

    const adminCtx = await browser.newContext();
    try {
      const admin = await adminCtx.newPage();
      await quiet(admin);
      await signIn(admin, org.username);
      await admin.goto("/users");
      await admin.locator(".tabs .tab").nth(1).click();
      const block = admin.getByTestId("guardian-requests");
      await expect(block).toContainText("Gwen Guardian");
      await expect(block).toContainText("Kiddo Lindqvist");
      await block.getByRole("button", { name: "Approve" }).click();
      await expect.poll(async () => (await setup.pool.query(
        "SELECT status FROM guardians WHERE guardian_user_id = $1", [parent.userId],
      )).rows[0]?.status).toBe("approved");
    } finally {
      await adminCtx.close();
    }
  });
});

// ---------------------------------------------------------------------
// A6-11: the language choice follows the account.
// ---------------------------------------------------------------------
test("A6-11 switching the UI language saves it to the account", async ({ page, browser, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Lola Langue" });
    await quiet(page);
    await signIn(page, diver.username);
    await page.goto("/profile");
    await page.locator(".locale-select").first().selectOption("fr");
    await expect.poll(async () => (await setup.pool.query(
      "SELECT locale FROM users WHERE id = $1", [diver.userId],
    )).rows[0].locale).toBe("fr");

    // A device that never picked a language follows the account. It
    // didn't: the boot-time browser-language guess was written to
    // localStorage, so every device looked like it had chosen already.
    // One that did pick with the switcher keeps its own choice.
    for (const [stored, expected] of [[null, "fr"], ["de", "de"]]) {
      const ctx = await browser.newContext();
      try {
        const other = await ctx.newPage();
        await quiet(other);
        if (stored) {
          await other.addInitScript((code) => {
            try { localStorage.setItem("locale", code); } catch { /* ignore */ }
          }, stored);
        }
        await signIn(other, diver.username);
        await other.goto("/profile");
        await expect(other.locator(".locale-select").first()).toHaveValue(expected);
        await expect(other.locator("html")).toHaveAttribute("lang", expected);
      } finally {
        await ctx.close();
      }
    }
  });
});

// ---------------------------------------------------------------------
// A6-12: a signed-in hard load mustn't detour through /login.
// ---------------------------------------------------------------------
test("A6-12 a signed-in reload of a guarded page doesn't bounce through /login", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Rita Reload" });
    await quiet(page);
    await signIn(page, diver.username);
    const loginChunks = [];
    page.on("request", (r) => { if (/\/assets\/LoginView/.test(r.url())) loginChunks.push(r.url()); });
    await page.goto("/inbox");
    await expect(page.locator(".inbox-wrap")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/inbox");
    expect(loginChunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// A6-13: deleting a custom dive (a 204) is a success.
// ---------------------------------------------------------------------
test("A6-13 deleting a custom dive reports success and drops the row", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const code = `9${Math.floor(Math.random() * 90000 + 10000)}`.slice(0, 5);
    const made = await request.post("/api/dive-directory", {
      headers: { Authorization: `Bearer ${org.adminToken}` },
      data: { dive_code: code, height: "3m", position: "B", dd: 2.3, description: "B6 probe dive" },
    });
    expect(made.status(), await made.text()).toBe(201);
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/dive-directory");
    await page.locator("input.input").first().fill(code);
    const row = page.locator("tr.dive-row", { hasText: "B6 probe dive" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();
    await page.locator(".confirm-backdrop").getByRole("button", { name: "Delete dive" }).click();
    await expect(page.locator(".notify-bar-success")).toContainText(`Deleted ${code}`);
    await expect(page.locator(".notify-bar-error")).toHaveCount(0);
    await expect(row).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------
// A6-14: no blank page for the palette's Dive Directory or a bad URL.
// ---------------------------------------------------------------------
test("A6-14 the command palette's Dive Directory opens it, and unknown paths aren't blank", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/dives");
    await page.waitForURL(/\/dashboard$/);
    await expect(page.locator(".sb-user")).toBeVisible();

    await page.keyboard.press("Control+k");
    await page.keyboard.type("Dive Directory");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/dive-directory$/);
    await expect(page.locator("tr.dive-row").first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------
// A6-15: the member view of a meet is cached under the member's key.
// ---------------------------------------------------------------------
test("A6-15 a member's view of a meet isn't cached under the anonymous key", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const meet = await (await request.post("/api/meets", {
      headers: { Authorization: `Bearer ${org.adminToken}` },
      data: { name: "B6 Cache Meet", venue: "Test Pool" },
    })).json();
    await quiet(page);
    await signIn(page, org.username);
    await page.goto(`/meet/${meet.id}`);
    await expect(page.getByText("B6 Cache Meet").first()).toBeVisible();
    const keys = () => page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open("dive-recorder-cache", 1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("api")) return resolve([]);
        const all = db.transaction("api", "readonly").objectStore("api").getAllKeys();
        all.onsuccess = () => resolve(all.result.map(String));
        all.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    }));
    const url = `/api/meets/${meet.id}`;
    await expect.poll(async () => (await keys()).some((k) => k.endsWith(url))).toBe(true);
    const cached = (await keys()).filter((k) => k.endsWith(url));
    expect(cached.filter((k) => k.startsWith("anon:"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// A6-16 + A6-17: sysadmin screens.
// ---------------------------------------------------------------------
test("A6-16 the audit log reloads other tabs after the org filter changes", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await setup.pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [org.adminId]);
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/audit");
    const scoresTab = page.getByRole("tab", { name: "Score corrections" }).or(page.locator(".tab", { hasText: "Score corrections" })).first();
    const recentTab = page.getByRole("tab", { name: "Recent activity" }).or(page.locator(".tab", { hasText: "Recent activity" })).first();
    await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/audit/scores")),
      scoresTab.click(),
    ]);
    await recentTab.click();
    const orgSelect = page.locator("select.select-sm").first();
    await expect(orgSelect.locator(`option[value="${org.orgId}"]`)).toHaveCount(1);
    await orgSelect.selectOption(org.orgId);
    const refetch = page.waitForRequest(
      (r) => r.url().includes("/api/audit/scores") && r.url().includes(`org_id=${org.orgId}`),
      { timeout: 5000 },
    );
    await scoresTab.click();
    await refetch;
  });
});

test("A6-17 leaving the Results Archive stops the import status poll", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await setup.pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [org.adminId]);
    let started = false;
    let polls = 0;
    await page.route("**/api/dr-archive/admin/import/status", (route) => {
      polls += 1;
      return route.fulfill({
        json: started
          ? { running: true, trigger: "manual", stats: { discovered: 0, meets: 0, results: 0 } }
          : { running: false },
      });
    });
    await page.route("**/api/dr-archive/admin/import", (route) => {
      started = true;
      return route.fulfill({ status: 202, json: { ok: true } });
    });
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/results-archive");
    await page.getByRole("button", { name: "Import now" }).click();
    await expect(page.getByRole("button", { name: /Importing/ })).toBeVisible();
    await page.getByRole("link", { name: /Back to Scoreboard/ }).click();
    await page.waitForURL(/\/scoreboard/);
    await page.waitForTimeout(500);
    const before = polls;
    await page.waitForTimeout(4000);
    expect(polls - before, "no status polls after leaving the page").toBe(0);
  });
});

// ---------------------------------------------------------------------
// A6-20: /teams mustn't leak a window keydown listener per visit.
// ---------------------------------------------------------------------
test("A6-20 visiting Teams leaves no keydown listener behind", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/dashboard");
    await expect(page.locator(".sb-user")).toBeVisible();
    const cdp = await page.context().newCDPSession(page);
    async function keydownListeners() {
      const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
      return listeners.filter((l) => l.type === "keydown").length;
    }
    const spaGo = (path) => page.evaluate((p) => {
      history.pushState({}, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    const baseline = await keydownListeners();
    const teamsLoaded = page.waitForResponse((r) => /\/api\/orgs\/[^/]+\/teams$/.test(new URL(r.url()).pathname));
    await spaGo("/teams");
    await page.waitForURL(/\/teams$/);
    await teamsLoaded;
    await spaGo("/dashboard");
    await page.waitForURL(/\/dashboard$/);
    await page.waitForTimeout(300);
    expect(await keydownListeners()).toBe(baseline);
  });
});

// ---------------------------------------------------------------------
// Scheduler edit mode: a click on a block, or the release at the end of
// dragging one, bubbled to the grid and opened the "add block" form on
// top of it. Stopping pointerdown doesn't stop the click that follows.
// ---------------------------------------------------------------------
test("the scheduler's add-block form opens on empty grid only, not on a block", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const headers = { Authorization: `Bearer ${org.adminToken}` };
    const meet = await (await request.post("/api/meets", {
      headers,
      data: { name: "B6 Schedule Meet", venue: "Test Pool", start_date: "2026-07-01", end_date: "2026-07-01" },
    })).json();
    await setup.createEvent(request, {
      adminToken: org.adminToken, meet_id: meet.id, name: "B6 3m", event_type: "individual",
      number_of_judges: 5, height: "3m", scheduled_at: "2026-07-01T09:00:00.000Z", total_rounds: 1,
    });
    // The first signed-in read seeds the sessions and their blocks.
    expect((await request.get(`/api/meets/${meet.id}/sessions`, { headers })).status()).toBe(200);

    await quiet(page);
    await signIn(page, org.username);
    await page.goto(`/meet/${meet.id}/schedule`);
    await page.locator(".scheduler-edit-toggle input").check();
    const first = page.locator(".scheduler-block").first();
    await expect(first).toBeVisible();
    const id = await first.getAttribute("data-block-id");
    const block = page.locator(`.scheduler-block[data-block-id="${id}"]`);
    const form = page.locator(".scheduler-insert-backdrop");

    await block.click();
    await page.waitForTimeout(300);
    await expect(form).toHaveCount(0);

    const box = await block.boundingBox();
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes(`/api/blocks/${id}`));
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 8 });
    await page.mouse.up();
    await saved;
    await page.waitForTimeout(300);
    await expect(form).toHaveCount(0);

    // Empty grid still offers the form.
    const grid = await page.locator(".scheduler-grid-body").first().boundingBox();
    await page.mouse.click(grid.x + grid.width - 8, grid.y + grid.height - 8);
    await expect(form).toBeVisible();
  });
});

// ---------------------------------------------------------------------
// A6-26 + A6-27 + A6-34: payments screens (payments is forced on here).
// ---------------------------------------------------------------------
test("A6-26 a fee's price window keeps its dates across a save and reload", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/payments");
    await page.locator(".tabs .tab", { hasText: "Fees & pricing" }).click();
    const editor = page.locator(".fee-editor").first();
    await editor.locator('input[type="number"]').first().fill("25");
    await editor.locator('input[type="date"]').nth(0).fill("2026-10-01");
    await editor.locator('input[type="date"]').nth(1).fill("2026-10-31");
    await editor.locator('button[type="submit"]').click();
    await expect(page.locator(".notify-bar-success")).toBeVisible();

    await page.reload();
    await page.locator(".tabs .tab", { hasText: "Fees & pricing" }).click();
    const again = page.locator(".fee-editor").first();
    await expect(again.locator('input[type="date"]').nth(0)).toHaveValue("2026-10-01");
    await expect(again.locator('input[type="date"]').nth(1)).toHaveValue("2026-10-31");
  });
});

test("A6-27 Download PDF on payment history opens the print dialog", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await page.route("**/api/me/payments", (route) => route.fulfill({
      json: {
        payments_enabled: true,
        payments: [{
          id: "p1", status: "paid", created_at: new Date().toISOString(),
          subject_type: "membership", membership_tier: null, amount_cents: 2500, currency: "GBP",
        }],
      },
    }));
    await page.addInitScript(() => {
      window.__printed = false;
      const open = window.open.bind(window);
      window.open = (...args) => {
        const w = open(...args);
        if (w) w.print = () => { window.__printed = true; };
        return w;
      };
    });
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/payment-history");
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Download PDF" }).click();
    await (await popup).close().catch(() => {});
    await expect.poll(() => page.evaluate(() => window.__printed)).toBe(true);
  });
});

test("A6-34 the payments admin tabs don't pick up the dashboard panel padding", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/payments");
    const tab = page.locator(".payments-admin .pa-panel, .payments-admin .panel").first();
    await expect(tab).toBeVisible();
    const pad = await tab.evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(pad).toBe("0px");
  });
});

// ---------------------------------------------------------------------
// A6-31 + A6-33: the diver's dive sheet.
// ---------------------------------------------------------------------
test("A6-31 the dive sheet can be filled in from the keyboard", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Kit Keyboard" });
    const ev = await setup.createEvent(request, { adminToken: org.adminToken, name: "B6 Keyboard Event", total_rounds: 2 });
    await quiet(page);
    await signIn(page, diver.username);
    await page.goto("/competitor");
    await page.locator("select.select").first().selectOption(ev.id);
    const rows = page.locator(".dive-row");
    await expect(rows).toHaveCount(2);
    await rows.first().focus();
    await page.keyboard.press("Enter");
    const modal = page.locator(".modal-backdrop .modal");
    await expect(modal).toBeVisible();
    const first = modal.locator(".result-item").first();
    await expect(first).toBeVisible();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(modal).toBeHidden();
    await expect(page.locator(".dive-row.filled")).toHaveCount(1);
  });
});

test("A6-33 a slow load for an earlier event pick can't overwrite the newer one", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const diver = await setup.insertUser({ orgId: org.orgId, role: "diver", fullName: "Sam Slowwifi" });
    const a = await setup.createEvent(request, { adminToken: org.adminToken, name: "B6 Event A", total_rounds: 3 });
    const b = await setup.createEvent(request, { adminToken: org.adminToken, name: "B6 Event B", total_rounds: 5 });
    const diveId = await setup.pickDiveId();
    const d = (await setup.pool.query(
      "SELECT dive_code, position, dd, description, height FROM dive_directory WHERE id = $1", [diveId],
    )).rows[0];
    // Event A's prescribed rounds arrive late, after B has been picked.
    await page.route(`**/api/events/${a.id}/round-dives`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        json: [1, 2, 3].map((n) => ({
          round_number: n, dive_id: diveId, height: 3,
          dive_code: d.dive_code, position: d.position, dd: d.dd,
          description: d.description, dive_height: d.height,
        })),
      });
    });
    await quiet(page);
    await signIn(page, diver.username);
    await page.goto("/competitor");
    const select = page.locator("select.select").first();
    await select.selectOption(a.id);
    await page.waitForTimeout(200);
    await select.selectOption(b.id);
    await page.waitForTimeout(2500);
    await expect(select).toHaveValue(b.id);
    await expect(page.locator(".dive-row")).toHaveCount(5);
    await expect(page.locator(".row-lock-tag")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------
// A6-32: Assign Judges on a quick event switch.
// ---------------------------------------------------------------------
test("A6-32 a slow panel load for one event doesn't land on the next", async ({ page, request }) => {
  await withOrg(request, async (org) => {
    const x = await setup.createEvent(request, { adminToken: org.adminToken, name: "B6 Panel X", number_of_judges: 5 });
    const y = await setup.createEvent(request, { adminToken: org.adminToken, name: "B6 Panel Y", number_of_judges: 5 });
    const judges = async (prefix) => {
      const out = [];
      for (let i = 1; i <= 5; i++) {
        out.push(await setup.insertUser({ orgId: org.orgId, role: "judge", fullName: `${prefix} Judge ${i}` }));
      }
      return out;
    };
    const xj = await judges("Xavier");
    const yj = await judges("Yolanda");
    await setup.assignJudges(request, { adminToken: org.adminToken, eventId: x.id, judgeIds: xj.map((j) => j.userId) });
    await setup.assignJudges(request, { adminToken: org.adminToken, eventId: y.id, judgeIds: yj.map((j) => j.userId) });

    await page.route(`**/api/events/${x.id}/judges`, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await quiet(page);
    await signIn(page, org.username);
    await page.goto("/assign-judges");
    const select = page.locator("select.select").first();
    await select.selectOption(x.id);
    await page.waitForTimeout(150);
    await select.selectOption(y.id);
    await page.waitForTimeout(2500);
    const names = await page.locator(".slot-name").allTextContents();
    expect(names.map((s) => s.trim())).toEqual(yj.map((_, i) => `Yolanda Judge ${i + 1}`));
  });
});

// ---------------------------------------------------------------------
// A6-23: the score-history popover asks the server every time it opens.
// ---------------------------------------------------------------------
test("A6-23 reopening a dive's score history fetches it again", async ({ page, request }) => {
  const sc = await setup.createEventScenario(request, { judgeCount: 5 });
  try {
    const admin = sc.hostOrg;
    await setup.setEventStatus(request, { adminToken: admin.adminToken, eventId: sc.event.id, status: "Live" });
    for (const [i, j] of sc.judges.entries()) {
      await setup.insertScore({
        eventId: sc.event.id, competitorId: sc.competitor.userId, judgeId: j.userId,
        diveId: sc.diveId, roundNumber: 1, score: 6 + i * 0.5,
      });
    }
    await setup.setEventStatus(request, { adminToken: admin.adminToken, eventId: sc.event.id, status: "Completed" });

    let audits = 0;
    page.on("request", (r) => { if (r.url().includes(`/api/events/${sc.event.id}/score-audit`)) audits += 1; });
    await quiet(page);
    await signIn(page, admin.username);
    await page.goto(`/scoreboard/${sc.event.id}`);
    // The recap starts on final standings only; switch that off to get
    // each diver's dives, where the history pill lives.
    await page.getByText(/Final scores only/i).click();
    const btn = page.locator(".score-history-btn").first();
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();
    await expect(page.locator(".score-history-pop")).toBeVisible();
    await expect.poll(() => audits).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".score-history-pop")).toHaveCount(0);
    await btn.click();
    await expect(page.locator(".score-history-pop")).toBeVisible();
    await expect.poll(() => audits, { message: "a second open asks the server again" }).toBe(2);
  } finally {
    await sc.cleanup();
  }
});
