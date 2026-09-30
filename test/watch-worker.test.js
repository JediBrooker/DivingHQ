// The watch Worker's plumbing (ops/watch/src/watch.js): probes, KV,
// sending, the retry outbox, GET / and GET /test-alert, plus a sanity pass
// over wrangler.toml. DB-less, runs in test:safe.
//
// index.js is the one file that imports "cloudflare:email", which Node
// can't load, so these build the Worker through createWorker() with a
// stand-in EmailMessage and drive it with a fake KV, fetch and send binding.
const { test, describe, before, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let watch;
before(async () => {
  watch = await import("../ops/watch/src/watch.js");
});
beforeEach(() => {
  // The Worker logs to the console on purpose (it's what wrangler tail
  // shows); keep the test output readable.
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
});

const MIN = 60_000;
const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const WATCH_DIR = path.join(__dirname, "..", "ops", "watch");

class FakeEmailMessage {
  constructor(from, to, raw) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

function fakeKv(initial) {
  const store = new Map(initial ? [["state", JSON.stringify(initial)]] : []);
  return {
    store,
    writes: 0,
    failGet: false,
    failPut: false,
    async get(key, type) {
      if (this.failGet) throw new Error("kv down");
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      if (this.failPut) throw new Error("KV put() limit exceeded for the day.");
      this.writes++;
      store.set(key, value);
    },
    get state() {
      return store.has("state") ? JSON.parse(store.get("state")) : null;
    },
  };
}

function fakeMail() {
  return {
    sent: [],
    fail: null,
    async send(msg) {
      if (this.fail) throw Object.assign(new Error(this.fail), { code: "E_DELIVERY_FAILED" });
      this.sent.push(msg);
      return { messageId: `m${this.sent.length}` };
    },
  };
}

function env(extra = {}) {
  return {
    TARGET: "https://divinghq.app",
    ALERT_TO: "ops@example.com",
    ALERT_FROM: "alerts@divinghq.app",
    ALERT_FROM_NAME: "DivingHQ watch",
    TIME_ZONE: "UTC",
    WATCH_STATE: fakeKv(),
    ALERT_EMAIL: fakeMail(),
    ...extra,
  };
}

const jsonRes = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function okStatus(now) {
  const t = (ms) => new Date(now - ms).toISOString();
  return {
    ok: true,
    schema_version: 99,
    time: new Date(now).toISOString(),
    backup: { last_attempt_at: t(3600e3), last_success_at: t(3600e3), last_ok: true, offsite: "ok", size_bytes: 1000 },
    restore_check: { last_run_at: t(86400e3), ok: true },
    deploy: { last_at: t(86400e3), ok: true, sha: "5323566" },
    errors: { window_minutes: 15, server_errors: 0, requests: 10 },
  };
}

// A fake fetch that serves the two endpoints; `mode` picks the scenario.
function site(mode, now) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (mode === "down") return new Response("<html>1033</html>", { status: 530 });
    if (url.endsWith("/api/health")) return jsonRes(200, { ok: true, schema_version: 99 });
    if (url.endsWith("/api/ops/status")) return jsonRes(200, okStatus(now));
    return new Response("nope", { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

// sleep is instant here; the retry tests below pass their own to see it.
const deps = (fetch, now, extra = {}) => ({ fetch, now, EmailMessage: FakeEmailMessage, timeoutMs: 200, sleep: async () => {}, ...extra });

describe("runCheck", () => {
  test("probes both endpoints with a timeout signal and no redirects", async () => {
    const e = env();
    const fetch = site("up", T0);
    await watch.runCheck(e, deps(fetch, T0));
    assert.deepEqual(
      fetch.calls.map((c) => c.url).sort(),
      ["https://divinghq.app/api/health", "https://divinghq.app/api/ops/status"],
    );
    for (const c of fetch.calls) {
      assert.equal(c.init.redirect, "manual");
      assert.ok(c.init.signal instanceof AbortSignal);
    }
  });

  test("a healthy run sends nothing and saves state", async () => {
    const e = env();
    const r = await watch.runCheck(e, deps(site("up", T0), T0));
    assert.deepEqual(r.alerts, []);
    assert.equal(e.ALERT_EMAIL.sent.length, 0);
    assert.equal(e.WATCH_STATE.writes, 1);
    assert.equal(e.WATCH_STATE.state.last.health.ok, true);
  });

  test("steady state only writes KV on the 30 minute heartbeat", async () => {
    const e = env();
    let now = T0;
    await watch.runCheck(e, deps(site("up", now), now));
    for (let i = 0; i < 14; i++) {
      now += 2 * MIN;
      await watch.runCheck(e, deps(site("up", now), now));
    }
    assert.equal(e.WATCH_STATE.writes, 1, "28 minutes of nothing happening is one write");
    now += 2 * MIN;
    await watch.runCheck(e, deps(site("up", now), now));
    assert.equal(e.WATCH_STATE.writes, 2);
    // Over a quiet day that's about 48 writes, far under the free plan's 1,000.
  });

  test("two failed runs send one email, built right", async () => {
    const e = env();
    await watch.runCheck(e, deps(site("down"), T0));
    assert.equal(e.ALERT_EMAIL.sent.length, 0);
    const r = await watch.runCheck(e, deps(site("down"), T0 + 2 * MIN));
    assert.equal(r.subject, "[DivingHQ] DOWN");
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
    const msg = e.ALERT_EMAIL.sent[0];
    assert.ok(msg instanceof FakeEmailMessage);
    assert.equal(msg.from, "alerts@divinghq.app");
    assert.equal(msg.to, "ops@example.com");
    assert.match(msg.raw, /^From: "DivingHQ watch" <alerts@divinghq\.app>\r\nTo: ops@example\.com\r\nSubject: \[DivingHQ\] DOWN\r\n/);
    assert.match(msg.raw, /HTTP 530/);
    assert.doesNotMatch(msg.raw, /[^\r]\n/);
    // Nothing more on the next run.
    await watch.runCheck(e, deps(site("down"), T0 + 4 * MIN));
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
  });

  test("a failed send keeps the alert in the outbox and retries next run", async () => {
    const e = env();
    await watch.runCheck(e, deps(site("down"), T0));
    e.ALERT_EMAIL.fail = "smtp said no";
    await assert.rejects(watch.runCheck(e, deps(site("down"), T0 + 2 * MIN)), /smtp said no/);
    assert.equal(e.WATCH_STATE.state.outbox.length, 1);
    assert.equal(e.WATCH_STATE.state.down.alerted, true, "the rule still counts as alerted");

    e.ALERT_EMAIL.fail = null;
    const r = await watch.runCheck(e, deps(site("down"), T0 + 10 * MIN));
    assert.equal(r.subject, "[DivingHQ] DOWN");
    assert.match(e.ALERT_EMAIL.sent[0].raw, /first attempt to email it failed/);
    assert.deepEqual(e.WATCH_STATE.state.outbox, []);
  });

  test("the outbox gives up on alerts older than 6 hours", async () => {
    const e = env();
    await watch.runCheck(e, deps(site("down"), T0));
    e.ALERT_EMAIL.fail = "still no";
    await assert.rejects(watch.runCheck(e, deps(site("down"), T0 + 2 * MIN)));
    // Recovery lands 7 hours later, still failing to send.
    await assert.rejects(watch.runCheck(e, deps(site("up", T0 + 7 * 60 * MIN), T0 + 7 * 60 * MIN)));
    const ids = e.WATCH_STATE.state.outbox.map((a) => a.id);
    assert.deepEqual(ids, ["down.recovered"]);
  });

  test("a missing recipient or binding is a failed send, not a crash that loses state", async () => {
    for (const broken of [{ ALERT_TO: undefined }, { ALERT_EMAIL: undefined }]) {
      const e = env(broken);
      await watch.runCheck(e, deps(site("down"), T0));
      await assert.rejects(watch.runCheck(e, deps(site("down"), T0 + 2 * MIN)));
      assert.equal(e.WATCH_STATE.state.outbox.length, 1);
    }
  });

  test("a failed KV write doesn't stop the check", async () => {
    const e = env();
    e.WATCH_STATE.failPut = true;
    const r = await watch.runCheck(e, deps(site("up", T0), T0));
    assert.deepEqual(r.alerts, []);
  });

  test("a failed KV read skips the run: nothing sent, nothing written over the real state", async () => {
    // A deploy failure fires on first sight, so a watcher that started
    // from a blank state on every failed read would send it every run.
    const failedDeploy = (now) => async (url) => {
      if (url.endsWith("/api/health")) return jsonRes(200, { ok: true });
      return jsonRes(200, { ...okStatus(now), deploy: { last_at: new Date(now).toISOString(), ok: false, sha: "abc1234" } });
    };
    const e = env();
    await watch.runCheck(e, deps(failedDeploy(T0), T0));
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
    const saved = e.WATCH_STATE.store.get("state");
    const writes = e.WATCH_STATE.writes;

    e.WATCH_STATE.failGet = true;
    for (let i = 1; i <= 3; i++) {
      await assert.rejects(watch.runCheck(e, deps(failedDeploy(T0), T0 + i * 2 * MIN)), /kv down/);
    }
    assert.equal(e.ALERT_EMAIL.sent.length, 1, "no repeats while KV can't be read");
    assert.equal(e.WATCH_STATE.writes, writes);
    assert.equal(e.WATCH_STATE.store.get("state"), saved);

    // KV back: carries on from the real state, still no repeat.
    e.WATCH_STATE.failGet = false;
    await watch.runCheck(e, deps(failedDeploy(T0), T0 + 8 * MIN));
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
  });

  test("garbage in KV is treated as a first run", async () => {
    const e = env({ WATCH_STATE: fakeKv({ version: 7, whatever: true }) });
    await watch.runCheck(e, deps(site("up", T0), T0));
    assert.equal(e.WATCH_STATE.state.version, 1);
  });

  test("a stored value that isn't JSON at all is treated as a first run too", async () => {
    const e = env();
    e.WATCH_STATE.store.set("state", "{not json");
    const r = await watch.runCheck(e, deps(site("up", T0), T0));
    assert.deepEqual(r.alerts, []);
    assert.equal(e.WATCH_STATE.state.version, 1);
  });
});

describe("probe", () => {
  test("a hung request comes back as a timeout", async () => {
    // On Node 22 AbortSignal.timeout's timer doesn't hold the process open,
    // so with nothing else pending the runner gave up on this test before
    // the abort fired (Node 24 and workerd don't mind). Keep our own timer
    // going until it does.
    const hang = (_url, init) =>
      new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      });
    const r = await watch.probe("https://x.test/api/health", hang, 30);
    assert.deepEqual(r, { httpStatus: null, body: null, error: "timed out after 30 ms" });
    const r2 = await watch.probe("https://x.test/api/health", hang, 1000);
    assert.equal(r2.error, "timed out after 1 s");
  });

  test("network errors, non-JSON and oversized bodies", async () => {
    const boom = async () => {
      throw new TypeError("fetch failed");
    };
    assert.deepEqual(await watch.probe("u", boom), { httpStatus: null, body: null, error: "network error: fetch failed" });
    const html = async () => new Response("<h1>oops</h1>", { status: 502 });
    assert.deepEqual(await watch.probe("u", html), { httpStatus: 502, body: null, error: null });
    const huge = async () => jsonRes(200, { ok: true, pad: "x".repeat(70 * 1024) });
    assert.equal((await watch.probe("u", huge)).body, null);
  });
});

describe("probe retries", () => {
  // Fails the first `failures` calls with a 520, then answers like a healthy site.
  const flaky = (failures) => {
    const fn = async (url) => {
      fn.calls.push(url);
      if (fn.calls.length <= failures) return new Response("", { status: 520 });
      return jsonRes(200, { ok: true, schema_version: 99 });
    };
    fn.calls = [];
    return fn;
  };
  const noSleep = async () => {};

  test("a failed probe is tried again 5 s later, and the first 200 wins", async () => {
    assert.equal(watch.PROBE_ATTEMPTS, 3);
    assert.equal(watch.PROBE_RETRY_DELAY_MS, 5000);
    const slept = [];
    const f = flaky(2);
    const r = await watch.probeWithRetry("https://x.test/api/health", f, { timeoutMs: 200, sleep: async (ms) => slept.push(ms) });
    assert.equal(r.httpStatus, 200);
    assert.equal(r.attempts, 3);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(slept, [5000, 5000]);
  });

  test("only lost requests are retried, never an answer from the app", async () => {
    for (const code of [502, 504, 520, 522, 524, 530]) assert.equal(watch.worthRetrying({ httpStatus: code }), true, `${code}`);
    assert.equal(watch.worthRetrying({ httpStatus: null, error: "timed out after 10 s" }), true);
    for (const code of [200, 301, 302, 403, 404, 429, 500, 503]) assert.equal(watch.worthRetrying({ httpStatus: code }), false, `${code}`);

    // The database-down 503 from /api/health: one request, not three, or the
    // watcher's own probes would fill the app's 5xx window.
    let calls = 0;
    const dbDown = async () => {
      calls++;
      return jsonRes(503, { ok: false });
    };
    const r = await watch.probeWithRetry("u", dbDown, { timeoutMs: 200, sleep: async () => {} });
    assert.deepEqual([r.httpStatus, r.attempts, calls], [503, 1, 1]);
  });

  test("three failures come back as the last one; a 200 is never retried, even ok:false", async () => {
    const f = flaky(99);
    const r = await watch.probeWithRetry("u", f, { timeoutMs: 200, sleep: noSleep });
    assert.deepEqual([r.httpStatus, r.attempts, f.calls.length], [520, 3, 3]);

    let calls = 0;
    const dbDown = async () => {
      calls++;
      return jsonRes(200, { ok: false });
    };
    const r2 = await watch.probeWithRetry("u", dbDown, { timeoutMs: 200, sleep: noSleep });
    assert.deepEqual([r2.httpStatus, r2.attempts, calls], [200, 1, 1]);
  });

  test("network errors and timeouts get the retries too", async () => {
    let calls = 0;
    const boom = async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return jsonRes(200, { ok: true });
    };
    const r = await watch.probeWithRetry("u", boom, { timeoutMs: 200, sleep: noSleep });
    assert.deepEqual([r.httpStatus, r.attempts, calls], [200, 3, 3]);
  });

  test("a site that keeps losing requests gets one FLAKY note, never DOWN", async () => {
    const e = env();
    for (let i = 0; i < 5; i++) {
      const t = T0 + i * 2 * MIN;
      const healthy = site("up", t);
      let dropped = false;
      // Every run's first health request is lost on the way in.
      const lossy = async (url, init) => {
        if (url.endsWith("/api/health") && !dropped) {
          dropped = true;
          return new Response("", { status: 520 });
        }
        return healthy(url, init);
      };
      const r = await watch.runCheck(e, deps(lossy, t));
      if (i < 4) assert.equal(e.ALERT_EMAIL.sent.length, 0, `nothing after ${i + 1} lossy runs`);
      else assert.equal(r.subject, "[DivingHQ] connection flaky");
    }
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
    assert.doesNotMatch(e.ALERT_EMAIL.sent[0].raw, /Subject: [^\r]*DOWN/);
    assert.equal(e.WATCH_STATE.state.down.fails, 0);
    assert.equal(e.WATCH_STATE.state.flaky.runs.length, 5);
  });

  test("a real outage still alerts on the second run, and says it tried three times", async () => {
    const e = env();
    const down = site("down");
    await watch.runCheck(e, deps(down, T0));
    assert.equal(down.calls.length, 6, "3 tries at each endpoint");
    await watch.runCheck(e, deps(site("down"), T0 + 2 * MIN));
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
    const text = e.ALERT_EMAIL.sent[0].raw.replace(/=\r\n/g, "");
    assert.match(text, /HTTP 530 after 3 tries/);
  });

  test("runCheck waits between tries with the real delay unless told otherwise", async () => {
    const slept = [];
    const e = env();
    await watch.runCheck(e, deps(flaky(1), T0, { sleep: async (ms) => slept.push(ms) }));
    assert.deepEqual(slept, [5000]);
  });
});

describe("shouldWrite", () => {
  test("writes on change, first run and heartbeat only", async () => {
    const { evaluate } = await import("../ops/watch/src/evaluate.js");
    const a = evaluate(null, {}, T0).state;
    assert.equal(watch.shouldWrite(null, a, T0), true);
    const b = evaluate(a, {}, T0 + 2 * MIN).state; // second failure: streak moves
    assert.equal(watch.shouldWrite(a, b, T0 + 2 * MIN), true);
    const c = evaluate(b, {}, T0 + 4 * MIN).state; // alerted already, nothing moves
    assert.equal(watch.shouldWrite(b, c, T0 + 4 * MIN), false);
    assert.equal(watch.shouldWrite(b, c, T0 + 2 * MIN + watch.HEARTBEAT_MS), true);
  });
});

describe("fetch handler", () => {
  const worker = () => watch.createWorker({ EmailMessage: FakeEmailMessage });
  const get = (w, e, p) => w.fetch(new Request(`https://divinghq-watch.example.workers.dev${p}`), e);

  test("GET / returns the stored state as JSON", async () => {
    const e = env();
    await watch.runCheck(e, deps(site("up", T0), T0));
    const res = await get(worker(), e, "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.target, "https://divinghq.app");
    assert.equal(body.state.version, 1);
    assert.equal(body.state.last.health.ok, true);
    // Nothing about who gets the email.
    assert.doesNotMatch(JSON.stringify(body), /ops@example\.com/);
  });

  test("GET / before the first run says so", async () => {
    const body = await (await get(worker(), env(), "/")).json();
    assert.equal(body.state, null);
  });

  test("GET / when KV can't be read is a 503, not an empty state", async () => {
    const e = env();
    e.WATCH_STATE.failGet = true;
    const res = await get(worker(), e, "/");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).state, undefined);
  });

  test("/test-alert is a 404 whenever TEST_KEY isn't set", async () => {
    for (const unset of [{}, { TEST_KEY: "" }, { TEST_KEY: undefined }]) {
      const e = env(unset);
      for (const p of ["/test-alert", "/test-alert?key=", "/test-alert?key=anything", "/test-alert?key=undefined"]) {
        assert.equal((await get(worker(), e, p)).status, 404, `${JSON.stringify(unset)} ${p}`);
      }
      assert.equal(e.ALERT_EMAIL.sent.length, 0);
    }
  });

  test("/test-alert with the wrong key is a 404, the right one sends", async () => {
    const e = env({ TEST_KEY: "correct horse battery staple" });
    assert.equal((await get(worker(), e, "/test-alert?key=nope")).status, 404);
    assert.equal((await get(worker(), e, "/test-alert")).status, 404);
    assert.equal(e.ALERT_EMAIL.sent.length, 0);
    const res = await get(worker(), e, "/test-alert?key=correct%20horse%20battery%20staple");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: true, subject: "[DivingHQ] test alert" });
    assert.equal(e.ALERT_EMAIL.sent.length, 1);
    assert.match(e.ALERT_EMAIL.sent[0].raw, /Subject: \[DivingHQ\] test alert\r\n/);
  });

  test("/test-alert reports a failed send instead of throwing", async () => {
    const e = env({ TEST_KEY: "k" });
    e.ALERT_EMAIL.fail = "E_RECIPIENT_NOT_ALLOWED";
    const res = await get(worker(), e, "/test-alert?key=k");
    assert.equal(res.status, 502);
    assert.equal((await res.json()).sent, false);
  });

  test("other paths and methods are 404s", async () => {
    const e = env({ TEST_KEY: "k" });
    assert.equal((await get(worker(), e, "/state")).status, 404);
    const post = await worker().fetch(new Request("https://w.example/test-alert?key=k", { method: "POST" }), e);
    assert.equal(post.status, 404);
    assert.equal(e.ALERT_EMAIL.sent.length, 0);
  });

  test("scheduled() runs a check", async () => {
    const e = env();
    const w = watch.createWorker({ EmailMessage: FakeEmailMessage, fetch: site("up", Date.now()) });
    await w.scheduled({ cron: "*/2 * * * *", scheduledTime: Date.now() }, e);
    assert.equal(e.WATCH_STATE.state.last.health.ok, true);
  });
});

describe("the Worker package", () => {
  const toml = fs.readFileSync(path.join(WATCH_DIR, "wrangler.toml"), "utf8");
  const value = (key) => {
    const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
    return m && m[1];
  };

  test("wrangler.toml has the name, schedule and bindings the code expects", () => {
    assert.equal(value("name"), "divinghq-watch");
    assert.ok(fs.existsSync(path.join(WATCH_DIR, value("main"))), "main points at a real file");
    assert.match(toml, /^crons = \["\*\/2 \* \* \* \*"\]$/m);
    assert.match(toml, /\[\[kv_namespaces\]\]\s*\nbinding = "WATCH_STATE"/);
    assert.match(toml, /\[\[send_email\]\]\s*\nname = "ALERT_EMAIL"/);
    assert.equal(value("TARGET"), "https://divinghq.app");
    assert.equal(value("ALERT_FROM"), "alerts@divinghq.app");
    // TEST_KEY and ALERT_TO are secrets. The repo is public, a var would
    // publish the key and the owner's inbox.
    assert.equal(value("TEST_KEY"), null);
    assert.equal(value("ALERT_TO"), null);
    assert.doesNotMatch(toml, /^[^#]*@(?!divinghq\.app")[^\s"]+"/m, "no personal address in wrangler.toml");
  });

  test("the entry point is the only file that touches the runtime module", () => {
    const src = path.join(WATCH_DIR, "src");
    for (const f of fs.readdirSync(src)) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
      for (const spec of imports) {
        if (f === "index.js" && spec === "cloudflare:email") continue;
        assert.match(spec, /^\.\/[a-z]+\.js$/, `${f} imports ${spec}: no npm packages, no runtime modules`);
      }
    }
    assert.match(fs.readFileSync(path.join(src, "index.js"), "utf8"), /import \{ EmailMessage \} from "cloudflare:email";/);
  });

  test("no npm dependencies, here or leaking into the root package", () => {
    const own = JSON.parse(fs.readFileSync(path.join(WATCH_DIR, "package.json"), "utf8"));
    assert.equal(own.type, "module");
    for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.equal(own[k], undefined, k);
    }
    const root = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    for (const k of ["dependencies", "devDependencies"]) {
      assert.equal((root[k] || {}).wrangler, undefined, `root ${k} has wrangler`);
    }
  });
});
