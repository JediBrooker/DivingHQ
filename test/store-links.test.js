// Unit tests for storesFor() in src/lib/storeLinks.js: which "Get the app"
// buttons the home and sign-in pages offer. The thing to pin is that a
// phone isn't offered the other platform's store.

const { test } = require("node:test");
const assert = require("node:assert/strict");

let mod;
async function load() {
  if (!mod) mod = await import("../src/lib/storeLinks.js");
  return mod;
}

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ asks for the desktop site and says it's a Mac.
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36",
};
const stores = (list) => list.map((s) => s.store);

test("a phone only gets its own store", async () => {
  const { storesFor, PLAY_STORE_URL, APP_STORE_URL } = await load();
  assert.deepEqual(storesFor({ userAgent: UA.android }), [{ store: "play", url: PLAY_STORE_URL }]);
  assert.deepEqual(storesFor({ userAgent: UA.iphone }), [{ store: "apple", url: APP_STORE_URL }]);
  assert.deepEqual(stores(storesFor({ userAgent: UA.ipad, maxTouchPoints: 5 })), ["apple"]);
});

test("a computer gets both", async () => {
  const { storesFor } = await load();
  assert.deepEqual(stores(storesFor({ userAgent: UA.mac, maxTouchPoints: 0 })), ["play", "apple"]);
  assert.deepEqual(stores(storesFor({ userAgent: UA.windows })), ["play", "apple"]);
  assert.deepEqual(stores(storesFor({})), ["play", "apple"]);
});
