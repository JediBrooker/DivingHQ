// App-wide layout rules that no single screen owns: centring in RTL, the
// modal open animation, sticky headers on the public pages, the mobile
// drawer, wide tables at phone width.
//
// These all regressed quietly once already. Each check measures what the
// user would see (a box on screen, a focused element) rather than
// asserting on a CSS declaration, so a different fix that gets the same
// result still passes.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

const world = {};

test.beforeAll(async ({ request }) => {
  const { orgId } = await setup.createOrgAndAdmin(request, { orgName: "Platform Layout Fed" });
  world.orgId = orgId;
  world.diver = await setup.insertUser({ orgId, role: "diver", fullName: "Rania Haddad" });
});

test.afterAll(async () => {
  if (world.orgId) await setup.deleteOrg(world.orgId);
});

// Session cookie straight onto the page's context, then wherever we're
// going. Quicker than the login form and the form isn't under test here.
async function signIn(page, username) {
  await setup.bypassRoleTour(page);
  const r = await page.request.post("/api/auth/login", {
    data: { username, password: setup.TEST_PASSWORD },
  });
  expect(r.status()).toBe(200);
}

async function useLocale(page, code) {
  await page.addInitScript((c) => {
    try { localStorage.setItem("locale", c); } catch { /* storage off */ }
  }, code);
}

// Opens Request role on /profile and samples the dialog box every frame
// for the length of its open animation (and a bit). Returns one entry per
// frame so a caller can check the whole fade-in, not just where it lands.
async function sampleRoleDialog(page) {
  await page.goto("/profile");
  const button = page.locator("[data-test-id=request-role-button]");
  await expect(button).toBeVisible();
  return page.evaluate(async () => {
    document.querySelector("[data-test-id=request-role-button]").click();
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      await new Promise((r) => requestAnimationFrame(r));
      const m = document.querySelector(".lb-modal");
      if (!m) continue;
      const r = m.getBoundingClientRect();
      out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
    }
    return { frames: out, vw: innerWidth, vh: innerHeight };
  });
}

test("a dialog opens centred and stays put while it fades in", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, world.diver.username);
  const { frames, vw, vh } = await sampleRoleDialog(page);
  expect(frames.length).toBeGreaterThan(5);
  for (const f of frames) {
    // fadeUp nudges it 12px on the way in, nothing else should move it.
    expect(Math.abs(f.cx - vw / 2)).toBeLessThan(2);
    expect(Math.abs(f.cy - vh / 2)).toBeLessThan(14);
  }
});

test("RTL: a dialog is centred on a phone, not pushed off the left edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLocale(page, "ar");
  await signIn(page, world.diver.username);
  const { frames, vw } = await sampleRoleDialog(page);
  expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
  expect(frames.length).toBeGreaterThan(5);
  const last = frames[frames.length - 1];
  expect(last.left).toBeGreaterThanOrEqual(0);
  expect(last.right).toBeLessThanOrEqual(vw);
  expect(Math.abs(last.cx - vw / 2)).toBeLessThan(2);
});

test("RTL: toasts and v-tip bubbles centre on their anchor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLocale(page, "ar");
  await page.goto("/privacy");
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl");

  const got = await page.evaluate(() => {
    // Toast stack: give it a toast-sized child so it has a width to
    // centre (it's empty and 0px wide at rest, which hides the bug).
    const stack = document.querySelector(".notify-stack");
    const probe = document.createElement("div");
    probe.style.cssText = "width:300px;height:40px";
    stack.appendChild(probe);
    const s = probe.getBoundingClientRect();
    probe.remove();

    // Global [data-tip] bubble. The pseudo element has no box we can ask
    // for, but its resolved left/width/transform are the used values.
    const host = document.createElement("span");
    host.setAttribute("data-tip", "A reasonably long tooltip bubble");
    host.textContent = "7.5";
    host.style.cssText = "position:fixed;top:300px;left:150px;width:40px;display:inline-block";
    document.body.appendChild(host);
    const cs = getComputedStyle(host, "::after");
    const tx = new DOMMatrix(cs.transform).m41;
    const tipCentre = parseFloat(cs.left) + tx + parseFloat(cs.width) / 2;
    host.remove();
    return { stackLeft: s.left, stackCentre: s.left + s.width / 2, vw: innerWidth, tipCentre, hostHalf: 20 };
  });
  expect(got.stackLeft).toBeGreaterThanOrEqual(0);
  expect(Math.abs(got.stackCentre - got.vw / 2)).toBeLessThan(2);
  expect(Math.abs(got.tipCentre - got.hostHalf)).toBeLessThan(2);
});

test("RTL: the .select chevron sits on the side the padding leaves free", async ({ page }) => {
  for (const [code, side] of [["en", "right"], ["ar", "left"]]) {
    await useLocale(page, code);
    await page.goto("/register");
    const sel = page.locator("select.select").first();
    await expect(sel).toBeVisible();
    const got = await sel.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        padLeft: parseFloat(cs.paddingLeft),
        padRight: parseFloat(cs.paddingRight),
        posX: cs.backgroundPositionX,
      };
    });
    // The wide padding is the chevron's lane; the background has to be
    // anchored to that same edge.
    const wideSide = got.padLeft > got.padRight ? "left" : "right";
    expect(wideSide).toBe(side);
    const anchoredRight = /right/.test(got.posX) || /^calc\(100%/.test(got.posX) || got.posX === "100%";
    expect(anchoredRight ? "right" : "left").toBe(side);
  }
});

test("public pages keep their sticky header while scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto("/");
  const nav = page.locator("nav.nav").first();
  await expect(nav).toBeVisible();
  await page.evaluate(() => { document.scrollingElement.scrollTop = 600; });
  await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollTop)).toBeGreaterThan(300);
  expect(await nav.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(0);

  await page.goto("/guide/running-a-meet");
  const side = page.locator("nav.gt-sidebar").first();
  await expect(side).toBeVisible();
  const before = await side.evaluate((el) => el.getBoundingClientRect().top);
  await page.evaluate(() => { document.scrollingElement.scrollTop = 1200; });
  await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollTop)).toBeGreaterThan(600);
  const after = await side.evaluate((el) => el.getBoundingClientRect().top);
  // Stuck at its top offset, not scrolled away with the page.
  expect(after).toBeGreaterThanOrEqual(0);
  expect(after).toBeLessThanOrEqual(before);
});

test("the closed mobile drawer is out of the tab order", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signIn(page, world.diver.username);
  await page.goto("/dashboard");
  await expect(page.locator("aside.sidebar")).toBeAttached();
  await expect(page.locator(".topbar")).toBeVisible();

  // Tab through the first stretch of the page. Nothing that gets focus
  // may be inside the off-canvas sidebar or off the screen.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      const r = el.getBoundingClientRect();
      return { inSidebar: !!el.closest("aside.sidebar"), right: r.right, text: (el.textContent || "").trim().slice(0, 30) };
    });
    expect(f.inSidebar, `tab ${i + 1} landed on "${f.text}" in the hidden drawer`).toBe(false);
  }

  // Open it and its links are reachable again.
  await page.locator(".topbar .icon-btn").first().click();
  await expect(page.locator(".app-shell.mobile-open")).toBeVisible();
  const link = page.locator("aside.sidebar a.sb-item").first();
  await link.focus();
  expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
});
