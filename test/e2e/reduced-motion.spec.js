// P1: reduced-motion + app-channel e2e.
//
// Verifies (a) the meet-day surfaces honour prefers-reduced-motion
// (the global guard in app.css collapses every looping animation),
// (b) the topbar Search / Cmd-K palette now flow through useAppChannel
// instead of the removed window.__openCommandPalette /
// window.__replayRoleTour globals, and (c) the new skip link is the
// first focusable element on a shelled page.
//
// Mirrors the sign-in + fixture pattern in visual-regression.spec.js.
const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
}

// Returns the class/tag of every element still looping forever with a
// non-trivial duration. Under reduced motion this should come back empty.
async function runningInfiniteAnimations(page) {
  return page.evaluate(() => {
    const offenders = [];
    for (const el of document.querySelectorAll("*")) {
      const s = getComputedStyle(el);
      const loops = s.animationIterationCount
        .split(",")
        .some((c) => c.trim() === "infinite");
      const runs = s.animationDuration
        .split(",")
        .some((d) => parseFloat(d) > 0.001);
      if (s.animationName !== "none" && loops && runs) {
        offenders.push(typeof el.className === "string" ? el.className : el.tagName);
      }
    }
    return offenders;
  });
}

test("meet-day surfaces honour prefers-reduced-motion", async ({ request, page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });

  const { username } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS",
    orgName: "Reduced Motion Diving",
  });
  await signIn(page, username);

  // The window globals are gone, the app channel replaced them.
  const globals = await page.evaluate(() => ({
    open: typeof window.__openCommandPalette,
    replay: typeof window.__replayRoleTour,
  }));
  expect(globals.open).toBe("undefined");
  expect(globals.replay).toBe("undefined");

  // Sanity check: the global guard collapses even a freshly-injected
  // infinite animation down to a near-zero duration.
  const probeDuration = await page.evaluate(() => {
    const el = document.createElement("div");
    el.style.animation = "spin 9s linear infinite";
    document.body.appendChild(el);
    return getComputedStyle(el).animationDuration;
  });
  expect(parseFloat(probeDuration)).toBeLessThan(0.01);

  // Nothing on the dashboard is looping.
  expect(await runningInfiniteAnimations(page)).toEqual([]);

  // Control Room: same guarantee, just on the densest operator surface.
  await page.goto("/control");
  await page.waitForLoadState("domcontentloaded");
  expect(await runningInfiniteAnimations(page)).toEqual([]);
});

test("skip link + topbar Search work via the app channel (no window globals)", async ({ request, page }) => {
  test.setTimeout(60_000);
  // Reduced motion holds the layout still so the topbar can't jitter
  // under Playwright's actionability check. The palette + skip link
  // don't depend on motion anyway.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { username } = await setup.createOrgAndAdmin(request, {
    countryCode: "AUS",
    orgName: "App Channel Diving",
  });
  await signIn(page, username);
  // A brand-new org lands on the setup wizard at /dashboard (not
  // AppShell-shelled) and the role tour only auto-starts there. Use
  // /control instead, a shelled route gated by neither, so the
  // AppShell skip link + topbar are the page chrome, then let it settle.
  await page.goto("/control");
  await page.waitForLoadState("networkidle");

  // Skip link should be the first focusable element on a shelled page.
  await page.keyboard.press("Tab");
  const firstFocus = await page.evaluate(() => ({
    cls: typeof document.activeElement?.className === "string" ? document.activeElement.className : "",
    text: document.activeElement?.textContent?.trim() || "",
  }));
  expect(firstFocus.cls).toContain("skip-link");
  expect(firstFocus.text).toBe("Skip to main content");

  // Topbar Search should open the palette via useAppChannel.openCommandPalette().
  const search = page.locator(".topbar-search");
  await search.waitFor({ state: "visible" });
  await search.click({ force: true });
  await expect(page.locator('.cmdk-backdrop[role="dialog"] .cmdk-input')).toBeVisible({ timeout: 5_000 });
});
