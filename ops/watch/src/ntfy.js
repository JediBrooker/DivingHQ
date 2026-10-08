// Alerts as an ntfy push (https://ntfy.sh) instead of an email. Picked
// over email when NTFY_TOPIC is set, see config() in watch.js. The wording
// is the email's (alertSections in evaluate.js), minus the footer, plus a
// priority so an outage buzzes the phone and a stale restore check doesn't.
//
// Published as JSON to the server root rather than with Title / Tags
// headers, so a non-ASCII title doesn't need RFC 2047 games.

import { alertSections } from "./evaluate.js";

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";
export const NTFY_TIMEOUT_MS = 10_000;
// ntfy.sh turns a message over 4096 bytes into an attachment, which reads
// badly in a notification. Leave a bit of room for the cut marker.
export const MAX_MESSAGE_BYTES = 3900;
// The same rule ntfy applies to topic names.
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;

// 5 is ntfy's "urgent" (long vibration, pops over other apps), 4 "high",
// 3 the default, 2 "low" (no sound). Anything not listed is a 3.
const PRIORITY = {
  down: 5,
  db: 5,
  "down.reminder": 4,
  "db.reminder": 4,
  "backup.failed": 4,
  "offsite.failed": 4,
  "restore.failed": 4,
  "deploy.failed": 4,
  "errors.spike": 4,
  flaky: 2,
  "status.unreachable": 2,
  "offsite.not_configured": 2,
};

export function priorityOf(id) {
  return PRIORITY[id] ?? 3;
}

export function isTopic(t) {
  return typeof t === "string" && TOPIC.test(t);
}

const utf8 = new TextEncoder();

// Cut at a code point, never inside a UTF-8 sequence.
function clip(text, maxBytes) {
  if (utf8.encode(text).length <= maxBytes) return text;
  const marker = "\n\n(cut short, the rest is in the Worker logs)";
  const room = maxBytes - utf8.encode(marker).length;
  let out = "";
  let size = 0;
  for (const ch of text) {
    const n = utf8.encode(ch).length;
    if (size + n > room) break;
    out += ch;
    size += n;
  }
  return out + marker;
}

/**
 * One run's alerts -> one ntfy message body (minus the topic).
 * @param {import('./evaluate.js').Alert[]} alerts
 * @param {{now: number, timeZone?: string, target?: string}} opts
 */
export function composePush(alerts, opts) {
  const { list, summary, sections } = alertSections(alerts, { now: opts.now, timeZone: opts.timeZone, via: "send" });
  const priority = Math.max(...list.map((a) => priorityOf(a.id)));
  // An all-clear gets a tick even though its priority is the default.
  const allClear = list.every((a) => a.id.endsWith(".recovered"));
  const tag = allClear ? "white_check_mark" : priority >= 5 ? "rotating_light" : priority >= 4 ? "warning" : "information_source";
  return {
    title: `DivingHQ: ${summary}`,
    message: clip(sections.join("\n\n"), MAX_MESSAGE_BYTES),
    priority,
    tags: [tag],
    click: opts.target || "https://divinghq.app",
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
 * Publish it. Throws on anything but a 2xx so runCheck() keeps the alerts
 * in the outbox for the next run, same as a failed email.
 */
export async function sendPush(cfg, push, fetchImpl, timeoutMs = NTFY_TIMEOUT_MS) {
  if (!isTopic(cfg.ntfyTopic)) throw new Error("NTFY_TOPIC isn't a valid ntfy topic name");
  const headers = { "content-type": "application/json", "user-agent": "divinghq-watch/1" };
  if (cfg.ntfyToken) headers.authorization = `Bearer ${cfg.ntfyToken}`;
  let res;
  try {
    res = await fetchImpl(`${cfg.ntfyServer}/`, {
      method: "POST",
      headers,
      body: JSON.stringify({ topic: cfg.ntfyTopic, ...push }),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (err) {
    throw new Error(`couldn't reach ntfy at ${cfg.ntfyServer}: ${String((err && err.message) || err).slice(0, 120)}`);
  }
  if (!res.ok) {
    const why = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`ntfy answered HTTP ${res.status}${why ? `: ${why}` : ""}`);
  }
}
