// The watch Worker's I/O: probe the site, load and save state in KV, send
// the email, answer GET / and GET /test-alert. The decisions all live in
// evaluate.js.
//
// This file never imports "cloudflare:email". index.js does, and passes
// EmailMessage in through createWorker(), so the tests can drive the whole
// thing from Node with a fake KV, a fake fetch and a fake mail binding.

import { evaluate, normalizeState, normalizeOutbox, significant, composeEmail, testAlert, worthRetrying, LIMITS } from "./evaluate.js";
import { buildMime } from "./mime.js";
import { composePush, sendPush, DEFAULT_NTFY_SERVER } from "./ntfy.js";
import { MINUTE, toMs } from "./format.js";

export const STATE_KEY = "state";
export const DEFAULT_TARGET = "https://divinghq.app";
export const DEFAULT_FROM = "alerts@divinghq.app";
export const DEFAULT_FROM_NAME = "DivingHQ watch";
export const PROBE_TIMEOUT_MS = 10_000;
// A probe that got lost on the way in is tried again, twice, 5 s apart,
// before the run counts it as failed. The box sits on a home line, and on
// a busy evening (30 Sep: a big download, then an hour of stray 520s) the
// odd request never reaches it. One lost request shouldn't be half a DOWN
// alert; a real outage fails all three tries anyway. Worst case a run
// takes 3 x 10 s + 2 x 5 s, fine for a cron Worker.
export const PROBE_ATTEMPTS = 3;
export const PROBE_RETRY_DELAY_MS = 5_000;
// Even when nothing changes, write the state now and then so GET / shows
// the Worker is alive. 30 min is 48 writes a day.
export const HEARTBEAT_MS = 30 * MINUTE;
const MAX_BODY_BYTES = 64 * 1024;

export function config(env = {}) {
  const target = String(env.TARGET || DEFAULT_TARGET).replace(/\/+$/, "");
  return {
    target,
    from: env.ALERT_FROM || DEFAULT_FROM,
    fromName: env.ALERT_FROM_NAME || DEFAULT_FROM_NAME,
    to: env.ALERT_TO || null,
    timeZone: env.TIME_ZONE || "UTC",
    // With a topic set, alerts go to ntfy and not by email at all. The
    // up/down emails were filling the inbox; a push is easier to swipe away.
    ntfyServer: String(env.NTFY_SERVER || DEFAULT_NTFY_SERVER).replace(/\/+$/, ""),
    ntfyTopic: env.NTFY_TOPIC || null,
    ntfyToken: env.NTFY_TOKEN || null,
    channel: env.NTFY_TOPIC ? "ntfy" : "email",
    // How long DOWN / DB wait before alerting. Gatus on the home network
    // pushes the short outages to ntfy, so this one can hold off and be
    // the backstop: a long outage, or the home line itself being down
    // (when Gatus can't tell anyone). One run is 2 minutes.
    debounceRuns: Math.ceil((Number(env.DOWN_ALERT_AFTER_MIN) || 0) / 2),
  };
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(new Error("timeout")), ms);
  return c.signal;
}

/**
 * GET one URL with a hard timeout. Never throws; a failure comes back as
 * { httpStatus: null, error } so evaluate() can say what went wrong.
 */
export async function probe(url, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS) {
  const signal = timeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      // A 302 to a login page is not "up". Take the status as it comes.
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "divinghq-watch/1", "cache-control": "no-cache" },
      signal,
    });
    let body = null;
    const text = await res.text();
    if (text.length <= MAX_BODY_BYTES) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { httpStatus: res.status, body, error: null };
  } catch (err) {
    const name = err && err.name;
    if (signal.aborted || name === "TimeoutError" || name === "AbortError") {
      const took = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
      return { httpStatus: null, body: null, error: `timed out after ${took}` };
    }
    const why = err && err.message ? `: ${String(err.message).slice(0, 120)}` : "";
    return { httpStatus: null, body: null, error: `network error${why}` };
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What's worth another try lives in evaluate.js (worthRetrying), so the
// retries here and the FLAKY rule there agree on what "lost" means. Never
// an answer from the app itself, bad news included: /api/health's 503 when
// the database is down gets counted in the app's own 5xx window, so
// tripling it would set off the ERRORS rule on the watcher's own probes.
export { worthRetrying };

/**
 * probe(), tried again while worthRetrying() says the request got lost.
 * Returns the first real answer, or the last failure, with `attempts`
 * saying how many tries it took.
 */
export async function probeWithRetry(url, fetchImpl, { timeoutMs = PROBE_TIMEOUT_MS, attempts = PROBE_ATTEMPTS, delayMs = PROBE_RETRY_DELAY_MS, sleep = wait } = {}) {
  const tries = Math.max(1, Math.floor(attempts) || 1);
  let res = null;
  for (let i = 1; i <= tries; i++) {
    res = await probe(url, fetchImpl, timeoutMs);
    if (!worthRetrying(res)) return { ...res, attempts: i };
    if (i < tries) await sleep(delayMs);
  }
  return { ...res, attempts: tries };
}

// Two different failures here, handled differently on purpose.
//   * KV answered but the value is junk: start clean. normalizeState() does
//     the same for a shape it doesn't know, and the worst case is one
//     repeated alert.
//   * KV didn't answer (get() threw): throw, and the caller skips the run.
//     Starting blank every 2 minutes would re-send everything that fires on
//     first sight (a failed deploy, the offsite reminder) on every run, and
//     save that blank state over the real one. DOWN can't fire without
//     state anyway, since its debounce lives in KV.
async function readState(env) {
  const text = await env.WATCH_STATE.get(STATE_KEY, "text");
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("divinghq-watch: stored state isn't JSON, starting fresh", err && err.message);
    return null;
  }
}

export function shouldWrite(prevRaw, next, now) {
  if (!prevRaw) return true;
  if (significant(prevRaw) !== significant(next)) return true;
  const last = toMs(normalizeState(prevRaw).lastRunAt);
  return last === null || now - last >= HEARTBEAT_MS;
}

// Keep unsent alerts for the next run, dropping ones old enough that a
// reminder or recovery note has taken over.
function keepForRetry(alerts, now) {
  return normalizeOutbox(alerts).filter((a) => now - toMs(a.at) < LIMITS.OUTBOX_MAX_AGE_MS);
}

// Returns the subject (or push title), for the logs and /test-alert.
async function sendAlerts(env, io, cfg, alerts, now) {
  if (cfg.channel !== "ntfy") return sendEmail(env, io.EmailMessage, cfg, alerts, now);
  const push = composePush(alerts, { now, timeZone: cfg.timeZone, target: cfg.target });
  try {
    await sendPush(cfg, push, io.fetch);
    return push.title;
  } catch (err) {
    // A watcher that can't reach anyone is worse than an email. ntfy.sh
    // counts anonymous posts per IP and Workers share their egress IPs, so
    // the daily quota can be gone before we've sent a thing (first deploy,
    // 9 Oct: HTTP 429). Email is still wired up, so fall back to it, and
    // only fail the run (outbox retry) when that doesn't work either.
    if (!cfg.to) throw err;
    console.error("divinghq-watch: ntfy failed, sending by email instead", err && err.message);
    try {
      return await sendEmail(env, io.EmailMessage, cfg, alerts, now);
    } catch (mailErr) {
      throw new Error(`${err.message}; the email fallback failed too: ${mailErr && mailErr.message}`);
    }
  }
}

async function sendEmail(env, EmailMessage, cfg, alerts, now) {
  if (!cfg.to) throw new Error("ALERT_TO isn't set, so there's nobody to email");
  if (!env.ALERT_EMAIL || typeof env.ALERT_EMAIL.send !== "function") {
    throw new Error("the ALERT_EMAIL send_email binding is missing");
  }
  const { subject, text } = composeEmail(alerts, { now, timeZone: cfg.timeZone, target: cfg.target });
  const raw = buildMime({ from: cfg.from, fromName: cfg.fromName, to: cfg.to, subject, text, date: new Date(now) });
  await env.ALERT_EMAIL.send(new EmailMessage(cfg.from, cfg.to, raw));
  return subject;
}

/**
 * One cron run. Returns what happened, for logs and tests. Throws after
 * saving state if the email couldn't be sent, and without sending or
 * saving anything if KV couldn't be read, so either run shows up as
 * failed in the dashboard's cron history.
 */
export async function runCheck(env, deps = {}) {
  const now = deps.now ?? Date.now();
  // Wrapped rather than passed bare, some runtimes object to fetch being
  // called with a `this` that isn't the global.
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  const retry = {
    timeoutMs: deps.timeoutMs ?? PROBE_TIMEOUT_MS,
    attempts: deps.attempts ?? PROBE_ATTEMPTS,
    delayMs: deps.retryDelayMs ?? PROBE_RETRY_DELAY_MS,
    sleep: deps.sleep ?? wait,
  };
  const cfg = config(env);

  const [health, status, stored] = await Promise.all([
    probeWithRetry(`${cfg.target}/api/health`, fetchImpl, retry),
    probeWithRetry(`${cfg.target}/api/ops/status`, fetchImpl, retry),
    readState(env).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
  ]);
  if (stored.error) {
    console.error("divinghq-watch: couldn't read state from KV, skipping this run", stored.error && stored.error.message);
    throw stored.error;
  }
  const prevRaw = stored.value;

  const { state, alerts } = evaluate(prevRaw, { health, status }, now, {
    timeZone: cfg.timeZone,
    target: cfg.target,
    debounceRuns: cfg.debounceRuns,
  });

  const pending = [...state.outbox, ...alerts];
  state.outbox = [];
  let sendError = null;
  let subject = null;
  if (pending.length) {
    try {
      subject = await sendAlerts(env, { EmailMessage: deps.EmailMessage, fetch: fetchImpl }, cfg, pending, now);
      console.log(`divinghq-watch: sent "${subject}" by ${cfg.channel}`);
    } catch (err) {
      sendError = err;
      state.outbox = keepForRetry(pending, now);
      console.error(`divinghq-watch: ${cfg.channel} failed, will retry next run`, err && (err.code || ""), err && err.message);
    }
  }

  if (shouldWrite(prevRaw, state, now)) {
    try {
      await env.WATCH_STATE.put(STATE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error("divinghq-watch: couldn't save state", err && err.message);
    }
  }

  if (sendError) throw sendError;
  return { alerts: pending, subject, state };
}

// Length-independent comparison. Hashing both sides first means the
// timing doesn't leak the key's length either.
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFound() {
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** GET / (the stored state) and GET /test-alert?key=... */
export async function handleFetch(request, env, deps = {}) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return notFound();

  if (url.pathname === "/") {
    const cfg = config(env);
    let raw;
    try {
      raw = await readState(env);
    } catch {
      return json({ target: cfg.target, error: "couldn't read the state from KV" }, 503);
    }
    return json({
      target: cfg.target,
      channel: cfg.channel,
      now: new Date(deps.now ?? Date.now()).toISOString(),
      state: raw ? normalizeState(raw) : null,
    });
  }

  if (url.pathname === "/test-alert") {
    // No key configured means no test path at all, and a wrong key looks
    // exactly like a missing route.
    const expected = typeof env.TEST_KEY === "string" ? env.TEST_KEY : "";
    const given = url.searchParams.get("key") || "";
    if (!expected || !given || !(await sameSecret(given, expected))) return notFound();
    if (request.method !== "GET") return notFound();
    const now = deps.now ?? Date.now();
    const cfg = config(env);
    try {
      const fetchImpl = deps.fetch ?? ((u, init) => fetch(u, init));
      const io = { EmailMessage: deps.EmailMessage, fetch: fetchImpl };
      const subject = await sendAlerts(env, io, cfg, [testAlert(now, cfg.target)], now);
      return json({ sent: true, subject });
    } catch (err) {
      return json({ sent: false, error: String((err && err.message) || err).slice(0, 200) }, 502);
    }
  }

  return notFound();
}

/**
 * The Worker's default export, built around whichever EmailMessage class
 * the runtime provides.
 */
export function createWorker({ EmailMessage, fetch: fetchImpl } = {}) {
  return {
    async scheduled(_controller, env) {
      await runCheck(env, { EmailMessage, fetch: fetchImpl });
    },
    async fetch(request, env) {
      return handleFetch(request, env, { EmailMessage, fetch: fetchImpl });
    },
  };
}
