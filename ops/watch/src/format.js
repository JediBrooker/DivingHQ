// Time helpers for the watch Worker. Kept apart from the rules so the
// rules file reads as rules, and so the tests can pin the formats.
//
// Everything here takes epoch milliseconds. Timestamps come off the wire
// (and out of KV) as ISO strings, which toMs() turns into numbers or null
// when they're missing or junk. Nothing in here throws on bad input, a
// watcher that crashes on a malformed field is worse than one that shrugs.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ISO string / Date / number -> epoch ms, or null.
export function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function toIso(ms) {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

// "12 min", "3 h 5 min", "2 d 4 h". Rounds to the minute and never says
// "0 min", because "back up after 0 min" reads like a bug.
export function formatDuration(ms) {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalMin = Math.max(1, Math.round(safe / MINUTE));
  if (totalMin < 60) return `${totalMin} min`;
  const totalH = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (totalH < 48) return m ? `${totalH} h ${m} min` : `${totalH} h`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

const partsCache = new Map();
function formatter(timeZone) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = {
      // en-US numeric parts are stable across ICU versions, the month and
      // weekday names we do ourselves (en-AU says "Sept", for one).
      parts: new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      }),
      // en-AU gives the friendly zone name (AEST / AEDT), UTC stays UTC.
      zone: new Intl.DateTimeFormat("en-AU", { timeZone, timeZoneName: "short" }),
    };
    partsCache.set(timeZone, f);
  }
  return f;
}

function validZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return "UTC";
  try {
    formatter(timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function wallClock(ms, timeZone) {
  const f = formatter(timeZone);
  const p = {};
  for (const part of f.parts.formatToParts(new Date(ms))) p[part.type] = part.value;
  const zonePart = f.zone.formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName");
  return {
    weekday: p.weekday,
    day: Number(p.day),
    month: MONTHS[Number(p.month) - 1] || p.month,
    year: p.year,
    time: `${p.hour}:${p.minute}`,
    zone: zonePart ? zonePart.value : timeZone,
  };
}

// "Tue 29 Sep 2026, 20:00 AEST (10:00 UTC)" for a local zone, or
// "Tue 29 Sep 2026, 10:00 UTC" when the zone is UTC. Emails are read on a
// phone half asleep, so the local time comes first.
export function formatWhen(ms, timeZone = "UTC") {
  const t = toMs(ms);
  if (t === null) return "unknown";
  const zone = validZone(timeZone);
  const w = wallClock(t, zone);
  const local = `${w.weekday} ${w.day} ${w.month} ${w.year}, ${w.time} ${w.zone}`;
  if (zone === "UTC" || zone === "Etc/UTC") return local;
  const u = wallClock(t, "UTC");
  return `${local} (${u.time} UTC)`;
}

// "Tue 29 Sep 2026, 20:00 AEST, 3 h ago". For facts read off the box,
// where how old the thing is matters as much as when it was.
export function formatAgo(ms, now, timeZone = "UTC") {
  const t = toMs(ms);
  if (t === null) return "never";
  const age = now - t;
  const when = formatWhen(t, timeZone);
  if (age < MINUTE) return `${when}, just now`;
  return `${when}, ${formatDuration(age)} ago`;
}
