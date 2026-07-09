// Daktronics bridge helpers.
//
// DivingHQ emits a vendor-neutral `venue.scoreboard_state` payload.
// This module flattens that state into deterministic fields and
// renders either:
//   - a fixed-width ASCII RTD frame for Daktronics ERTD/template use
//   - newline-delimited JSON for Data Studio-style JSON ingestion
//
// It intentionally doesn't implement fixed-digit MDP; those protocol
// details are hardware/model-specific. This bridge just targets the
// RTD/ERTD data feeds that Daktronics display software can template.

const NEWLINES = {
  crlf: "\r\n",
  lf: "\n",
  none: "",
};

const DEFAULT_MAX_JUDGES = 11;
const DEFAULT_TOP_N = 8;

function rtdPortForSource(source) {
  const n = Number(source);
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new Error("Daktronics ERTD source must be an integer from 0 to 99");
  }
  return 21000 + (n * 10);
}

function toAscii(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "");
}

function cleanText(value) {
  return toAscii(value).replace(/\s+/g, " ").trim();
}

function cleanNumber(value, decimals = 2) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(decimals);
}

function cleanInt(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return String(Math.trunc(n));
}

function padField(value, width, align = "left") {
  const raw = cleanText(value).slice(0, width);
  return align === "right" ? raw.padStart(width, " ") : raw.padEnd(width, " ");
}

function scoreValue(scores, index) {
  const score = Array.isArray(scores) ? scores[index] : null;
  return score == null ? "" : cleanNumber(score, 1);
}

function leaderboardRow(state, index) {
  return Array.isArray(state?.leaderboard) ? state.leaderboard[index] || null : null;
}

function flattenScoreboardState(state, options = {}) {
  const maxJudges = options.maxJudges || DEFAULT_MAX_JUDGES;
  const topN = options.topN || DEFAULT_TOP_N;
  const active = state?.active_diver || {};
  const dive = state?.active_dive || {};
  const event = state?.event || {};

  const fields = {
    dhq_schema: cleanInt(state?.schema_version || 1),
    dhq_sequence: cleanInt(state?.sequence),
    emitted_at: cleanText(state?.emitted_at),
    event_id: cleanText(state?.event_id || event.id),
    event_name: cleanText(event.name),
    event_status: cleanText(event.status),
    event_type: cleanText(event.event_type),
    board_height: cleanNumber(event.height, 1),
    round: cleanInt(event.round),
    total_rounds: cleanInt(event.total_rounds),
    hold: event.on_hold ? "1" : "0",
    hold_reason: cleanText(event.on_hold_reason),
    diver_id: cleanText(active.competitor_id),
    diver_name: cleanText(active.name),
    partner_name: cleanText(active.partner_name),
    country_code: cleanText(active.country_code).slice(0, 3).toUpperCase(),
    club_code: cleanText(active.club_code).slice(0, 8).toUpperCase(),
    display_order: cleanInt(active.display_order),
    dive_code: cleanText(dive.code),
    dive_position: cleanText(dive.position),
    dive_dd: cleanNumber(dive.dd, 1),
    dive_description: cleanText(dive.description),
    dive_total: cleanNumber(state?.dive_total, 2),
    running_total: cleanNumber(state?.running_total, 2),
    current_rank: cleanInt(state?.current_rank),
    field_size: cleanInt(state?.field_size),
  };

  for (let i = 0; i < maxJudges; i++) {
    fields[`judge_${i + 1}_score`] = scoreValue(state?.scores, i);
  }

  for (let i = 0; i < topN; i++) {
    const row = leaderboardRow(state, i) || {};
    fields[`leader_${i + 1}_rank`] = cleanInt(row.rank);
    fields[`leader_${i + 1}_name`] = cleanText(row.name);
    fields[`leader_${i + 1}_country`] = cleanText(row.country_code).slice(0, 3).toUpperCase();
    fields[`leader_${i + 1}_total`] = cleanNumber(row.total, 2);
  }

  return fields;
}

function buildFixedLayout(options = {}) {
  const maxJudges = options.maxJudges || DEFAULT_MAX_JUDGES;
  const topN = options.topN || DEFAULT_TOP_N;
  const layout = [
    ["dhq_schema", 2, "right"],
    ["dhq_sequence", 8, "right"],
    ["emitted_at", 24, "left"],
    ["event_name", 40, "left"],
    ["event_status", 12, "left"],
    ["event_type", 16, "left"],
    ["board_height", 5, "right"],
    ["round", 2, "right"],
    ["total_rounds", 2, "right"],
    ["hold", 1, "right"],
    ["hold_reason", 32, "left"],
    ["diver_name", 32, "left"],
    ["partner_name", 32, "left"],
    ["country_code", 3, "left"],
    ["club_code", 8, "left"],
    ["display_order", 3, "right"],
    ["dive_code", 8, "left"],
    ["dive_position", 2, "left"],
    ["dive_dd", 5, "right"],
    ["dive_description", 48, "left"],
  ];

  for (let i = 0; i < maxJudges; i++) {
    layout.push([`judge_${i + 1}_score`, 4, "right"]);
  }

  layout.push(
    ["dive_total", 8, "right"],
    ["running_total", 8, "right"],
    ["current_rank", 3, "right"],
    ["field_size", 3, "right"],
  );

  for (let i = 0; i < topN; i++) {
    const n = i + 1;
    layout.push(
      [`leader_${n}_rank`, 3, "right"],
      [`leader_${n}_name`, 28, "left"],
      [`leader_${n}_country`, 3, "left"],
      [`leader_${n}_total`, 8, "right"],
    );
  }

  return layout.map(([key, width, align], index) => ({
    item: index + 1,
    key,
    width,
    align,
  }));
}

function newlineFor(name = "crlf") {
  if (!Object.hasOwn(NEWLINES, name)) {
    throw new Error(`Unsupported newline "${name}". Use crlf, lf, or none.`);
  }
  return NEWLINES[name];
}

function formatFixedRtdFrame(state, options = {}) {
  const fields = flattenScoreboardState(state, options);
  const layout = buildFixedLayout(options);
  const body = layout
    .map((field) => padField(fields[field.key], field.width, field.align))
    .join("");
  return Buffer.from(body + newlineFor(options.newline || "crlf"), "ascii");
}

function formatJsonFrame(state, options = {}) {
  const fields = flattenScoreboardState(state, options);
  return Buffer.from(JSON.stringify(fields) + newlineFor(options.newline || "crlf"), "utf8");
}

function formatFrame(state, options = {}) {
  const format = options.format || "rtd";
  if (format === "rtd" || format === "fixed") return formatFixedRtdFrame(state, options);
  if (format === "json") return formatJsonFrame(state, options);
  throw new Error(`Unsupported bridge format "${format}". Use rtd or json.`);
}

module.exports = {
  DEFAULT_MAX_JUDGES,
  DEFAULT_TOP_N,
  buildFixedLayout,
  cleanText,
  flattenScoreboardState,
  formatFixedRtdFrame,
  formatFrame,
  formatJsonFrame,
  rtdPortForSource,
};
