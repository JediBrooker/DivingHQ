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
