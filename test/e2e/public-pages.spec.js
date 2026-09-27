// The public, signed-out surface a new club sees first: the legal pages, the
// consent line on both sign-up forms, and the support contact in the
// footers. No fixtures, nothing to clean up, so it's safe to run alongside
// anything.

const { test, expect } = require("@playwright/test");

test.describe("legal pages", () => {
  test("/privacy and /terms render the docs, with a footer between them", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "DivingHQ Privacy Policy" })).toBeVisible();
    // The claims clause is the part clubs most need to find.
    await expect(page.getByRole("heading", { name: /Clubs that join before their federation/ })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("[Legal entity name]");
    await expect(page.locator("body")).not.toContainText("your-domain.example");

    const footer = page.locator(".legal-footer");
    await expect(footer.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "mailto:support@divinghq.app");
    await footer.getByRole("link", { name: "Terms of Service" }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByRole("heading", { level: 1, name: "DivingHQ Terms of Service" })).toBeVisible();

    // The in-text link back to the policy stays inside the SPA.
    await page.locator(".md-article a[href='/privacy']").first().click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "DivingHQ Privacy Policy" })).toBeVisible();
  });

  test("non-English readers are told the legal text is English", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("locale", "de"));
    await page.goto("/terms");
    await expect(page.locator(".legal-lang-note")).toContainText("nur auf Englisch");
    await expect(page.locator(".legal-footer")).toContainText("Datenschutzerklärung");
  });

  for (const path of ["/register", "/register-org"]) {
    test(`${path} carries the consent line under the submit button`, async ({ page }) => {
      await page.goto(path);
      const consent = page.getByTestId("legal-consent");
      await expect(consent).toContainText("By creating an account you agree to the");
      // New tab, so reading the policy doesn't lose a half-filled form.
      await expect(consent.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
      await expect(consent.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("target", "_blank");
      await expect(consent.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    });
  }
});

test.describe("support contact", () => {
  test("the public config names the support inbox", async ({ request }) => {
    const res = await request.get("/api/public-config");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ support_email: "support@divinghq.app" });
  });

  test("sign-in and home footers link to support and the legal pages", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("login-support")).toHaveAttribute("href", "mailto:support@divinghq.app");
    await expect(page.getByTestId("login-support")).toContainText("support@divinghq.app");
    await expect(page.locator(".legal-links").getByRole("link", { name: "Privacy Policy" })).toBeVisible();

    await page.goto("/");
    const footer = page.locator(".site-footer");
    await expect(footer.getByTestId("home-contact")).toHaveAttribute("href", "mailto:support@divinghq.app");
    await expect(footer.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    await expect(footer.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  });
});

test.describe("home page", () => {
  test("leads with starting a club, federations get the quieter link", async ({ page }) => {
    await page.goto("/");
    const primary = page.locator(".hero-cta .btn-primary");
    await expect(primary).toHaveCount(1);
    await expect(primary).toHaveText("Start your club");
    await expect(primary).toHaveAttribute("href", "/register");
    await expect(page.locator(".lede")).toContainText("No federation needed to start");
    await expect(page.getByTestId("hero-federation")).toHaveAttribute("href", "/register-org");
    await expect(page.getByTestId("for-clubs")).toContainText("Invite divers and judges");
    await expect(page.getByTestId("footer-federation")).toHaveText("For federations & state bodies");
  });

  // The strip's pill used to pulse red on every visit. Pin both states by
  // answering the live-events query ourselves, so what the shared test DB
  // happens to have running doesn't matter.
  const pulse = (page) => page.locator(".live-pill").evaluate((el) => getComputedStyle(el, "::before").animationName);

  test("the LIVE pill stays quiet when nothing is live", async ({ page }) => {
    await page.route("**/api/events?status=Live*", (route) => route.fulfill({ json: [] }));
    await page.goto("/");
    const strip = page.getByTestId("live-strip");
    await expect(strip).toHaveAttribute("data-live", "no");
    await expect(strip.locator(".live-pill")).toHaveText("Live scores");
    await expect(strip.getByRole("link")).toHaveText("Browse results →");
    expect(await pulse(page)).toBe("none");
  });

  test("the LIVE pill pulses while an event is live", async ({ page }) => {
    await page.route("**/api/events?status=Live*", (route) => route.fulfill({
      json: [{ id: "00000000-0000-0000-0000-000000000abc", name: "Women 3m", status: "Live" }],
    }));
    await page.goto("/");
    const strip = page.getByTestId("live-strip");
    await expect(strip).toHaveAttribute("data-live", "yes");
    await expect(strip.locator(".live-pill")).toHaveText("LIVE");
    await expect(strip.getByRole("link")).toHaveText("Watch Live →");
    // Scoped styles suffix the keyframes name with the component's hash.
    expect(await pulse(page)).toMatch(/^pulse-red/);
  });
});

test.describe("titles and link previews", () => {
  test("each public page names itself in the tab", async ({ page }) => {
    for (const [path, title] of [
      ["/", "DivingHQ · Diving competition software for clubs and federations"],
      ["/login", "Sign In · DivingHQ"],
      ["/privacy", "Privacy Policy · DivingHQ"],
      ["/terms", "Terms of Service · DivingHQ"],
      ["/guide", "User Guide · DivingHQ"],
      ["/guide/faq", "FAQ & Troubleshooting · DivingHQ"],
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveTitle(title);
    }
    // A client-side hop between topics retitles too.
    await page.locator(".gt-sidebar").getByRole("link", { name: "Quick Start" }).click();
    await expect(page).toHaveTitle("Quick Start · DivingHQ");
  });

  // Jumping to a heading, or Back from one, is a navigation too, so the
  // router's afterEach fires with the route's generic "User Guide" title.
  // The topic has to put its own name back each time.
  test("a guide topic keeps its title when you jump to a heading and back", async ({ page }) => {
    await page.goto("/guide/faq");
    await expect(page).toHaveTitle("FAQ & Troubleshooting · DivingHQ");
    await page.locator(".md-article a[href='#authentication']").first().click();
    await expect(page).toHaveURL(/#authentication$/);
    await expect(page).toHaveTitle("FAQ & Troubleshooting · DivingHQ");
    await page.goBack();
    await expect(page).toHaveURL(/\/guide\/faq$/);
    await expect(page).toHaveTitle("FAQ & Troubleshooting · DivingHQ");
  });

  test("titles follow the language", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("locale", "de"));
    await page.goto("/login");
    await expect(page).toHaveTitle("Anmelden · DivingHQ");
  });

  test("the served shell carries preview tags and a canonical URL for the page asked for", async ({ request }) => {
    const res = await request.get("/guide/faq");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+\/guide\/faq">/);
    expect(html).toMatch(/<meta property="og:url" content="https?:\/\/[^"]+\/guide\/faq">/);
    expect(html).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+\/og-image\.png">/);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');

    const home = await (await request.get("/")).text();
    expect(home).toMatch(/<link rel="canonical" href="https?:\/\/[^"/]+\/">/);

    const img = await request.get("/og-image.png");
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toBe("image/png");
  });

  test("robots.txt and sitemap.xml aren't the SPA shell", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.headers()["content-type"]).toMatch(/^text\/plain/);
    // The origin is APP_BASE_URL's when the server has one (lib/spa-shell.js),
    // so don't pin divinghq.app, just that both files agree on it.
    const origin = (await robots.text()).match(/^Sitemap: (https?:\/\/[^/\s]+)\/sitemap\.xml$/m)?.[1];
    expect(origin).toBeTruthy();
    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.headers()["content-type"]).toMatch(/xml/);
    expect(await sitemap.text()).toContain(`<loc>${origin}/privacy</loc>`);
  });
});

test.describe("guide", () => {
  test("Quick Start is written for divinghq.app, with no bootstrap login", async ({ page }) => {
    await page.goto("/guide/quick-start");
    const article = page.locator(".md-article");
    await expect(page.getByRole("heading", { name: "1. Create your account and your club" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Federations and state bodies" })).toBeVisible();
    await expect(article).not.toContainText("fresh DivingHQ install");
    await expect(article).not.toContainText(/password\s+admin/i);

    await page.goto("/guide/faq");
    await expect(page.locator(".md-article")).not.toContainText("gen_salt");
    await expect(page.getByRole("heading", { name: "Clubs and federations" })).toBeVisible();
  });

  // marked stopped writing heading ids, so every "#section" link in the
  // guide went nowhere. src/lib/markdown.js puts them back.
  test("links to a heading land on it, across topics and within one", async ({ page }) => {
    await page.goto("/guide/quick-start");
    await page.locator(".md-article a[href='/guide/roles-and-permissions#claims']").click();
    await expect(page).toHaveURL(/\/guide\/roles-and-permissions#claims$/);
    await expect(page.locator("h2#claims")).toBeInViewport();

    await page.goto("/guide/faq");
    await page.locator(".md-article a[href='#authentication']").first().click();
    await expect(page.locator("h2#authentication")).toBeInViewport();
  });

  test("a shared link with a heading opens scrolled to it", async ({ page }) => {
    await page.goto("/guide/roles-and-permissions#divers-represent");
    await expect(page.locator("h2#divers-represent")).toBeInViewport();
  });

  test("the primer's FAQ names the support address", async ({ page }) => {
    await page.goto("/guide");
    const account = page.locator(".guide-faq-item").filter({ hasText: "delete my account" });
    await account.locator("summary").click();
    await expect(account.locator(".guide-faq-body")).toContainText("support@divinghq.app");
  });
});
