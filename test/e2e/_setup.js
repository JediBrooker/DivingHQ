// Shared fixtures for the e2e suite. Each test file requires
// these helpers to get an isolated org + admin + supporting
// users/events without re-implementing the same dance.
//
// Design choice: setup goes through a mix of the public API
// (so we exercise real code paths where it's cheap) and direct
// SQL writes (for the bits that are otherwise gated by
// out-of-band steps — email verification clicks, sysadmin org
// approvals — that would make every test 10× slower for no
// extra coverage). Same trade-off the integration test makes
// (see test/integration.test.js).
//
// Tests run in parallel — every helper that creates state uses
// a per-test random slug so two parallel tests never collide.

const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const { io } = require("socket.io-client");
require("dotenv").config();

// Reuse the same DB the integration tests target. Falls back to
// libpq env vars (PGHOST/etc.) if DB_* aren't set, matching
// server.js + the rest of the codebase.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user:     process.env.DB_USER     || process.env.PGUSER,
      host:     process.env.DB_HOST     || process.env.PGHOST,
      database: process.env.DB_DATABASE || process.env.PGDATABASE,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      port:     process.env.DB_PORT     || process.env.PGPORT,
    });

// Constant password used for every synthetic user. Real e2e tests
// shouldn't be in the business of testing password strength —
// that's a unit-test concern. We just need a string ≥8 chars
// that bcrypt-compares cleanly.
const TEST_PASSWORD = "e2e-test-password-1234";

function openSocket(baseURL, token) {
  return new Promise((resolve, reject) => {
    const sock = io(baseURL, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });
    const timer = setTimeout(() => {
      sock.disconnect();
      reject(new Error("socket connect timeout"));
    }, 5000);
    sock.on("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function submitJudgeScore({
  baseURL,
  token,
  eventId,
  competitorId,
  roundNumber,
  diveId,
  score,
}) {
  const sock = await openSocket(baseURL, token);
  try {
    sock.emit("subscribe_event", { event_id: eventId });
    const ack = new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        sock.off("score_received", onAck);
        sock.off("score_rejected", onRej);
      };
      const onAck = () => { cleanup(); resolve(); };
      const onRej = (m) => {
        cleanup();
        reject(new Error(`score rejected: ${JSON.stringify(m)}`));
      };
      sock.on("score_received", onAck);
      sock.on("score_rejected", onRej);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("score ack timeout"));
      }, 5000);
    });
    sock.emit("submit_score", {
      event_id: eventId,
      competitor_id: competitorId,
      round_number: roundNumber,
      score,
      dive_id: diveId,
    });
    await ack;
  } finally {
    sock.disconnect();
  }
}

async function submitPanelScores({
  baseURL,
  judges,
  eventId,
  competitorId,
  roundNumber,
  diveId,
  scores = [7.0, 7.5, 8.0, 8.5, 9.0],
}) {
  for (let i = 0; i < judges.length; i++) {
    await submitJudgeScore({
      baseURL,
      token: judges[i].token,
      eventId,
      competitorId,
      roundNumber,
      diveId,
      score: scores[i % scores.length],
    });
  }
}

function collectApiErrors(page) {
  const errors = [];
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/") && response.status() >= 500) {
      errors.push(`${response.status()} ${url}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`page error: ${err.message}`);
  });
  return errors;
}

function rand() {
  return crypto.randomBytes(4).toString("hex");
}

// Register a fresh org via /api/auth/register-org, mark the org
// active + the founding admin email-verified (both gates would
// otherwise refuse login on a synthetic user with no real
// inbox), then log in via /api/auth/login. Returns everything
// the rest of a test needs to act as that org's admin.
async function createOrgAndAdmin(request, opts = {}) {
  const slug = `e2e-${rand()}`;
  const username = `e2e-admin-${slug}`;
  // Optional country override — defaults to "TST" so existing
  // callers don't change. Specs that drive the watcher mode pass
  // a real ISO-ish code (NZL / DEU / etc.) so the country chip
  // on history cards reads like a live meet.
  const countryCode = (opts.countryCode || "TST").slice(0, 3).toUpperCase();
  const orgName = opts.orgName || `E2E Org ${slug}`;

  // 1. Create the org + founding admin via the public API.
  // `email` is required by the validation hardening in
  // routes/auth.js's register-org handler (commit 1169992).
  // The synthetic mailbox doesn't exist, but step 2 below
  // marks the admin email-verified directly via SQL so no
  // verification email is actually needed.
  const reg = await request.post("/api/auth/register-org", {
    data: {
      org_name:     orgName,
      country_code: countryCode,
      slug,
      username,
      password:     TEST_PASSWORD,
      full_name:    "E2E Test Admin",
      email:        `${username}@example.test`,
    },
  });
  if (reg.status() !== 201) {
    throw new Error(`register-org ${reg.status()}: ${await reg.text()}`);
  }
  const { org_id: orgId } = await reg.json();

  // 2. Sysadmin bypass: mark the org active + admin verified
  //    directly. The real flow needs a sysadmin to approve the
  //    org and the admin to click an email link; both are
  //    out-of-band for an e2e and would 10× the test runtime.
  await pool.query(
    "UPDATE organisations SET status = 'active' WHERE id = $1",
    [orgId],
  );
  const u = await pool.query(
    `UPDATE users SET email_verified_at = now()
     WHERE org_id = $1 AND username = $2 RETURNING id`,
    [orgId, username],
  );
  const adminId = u.rows[0].id;

  // 3. Log in via the public API to get a real session JWT.
  const login = await request.post("/api/auth/login", {
    data: { username, password: TEST_PASSWORD },
  });
  if (login.status() !== 200) {
    throw new Error(`login ${login.status()}: ${await login.text()}`);
  }
  const { token: adminToken } = await login.json();

  return { orgId, adminId, adminToken, slug, username, countryCode };
}

// Insert a user with a single org_role directly. Bypasses the
// public registration flow because we don't need to exercise it
// in every test — just need a user with the role set up.
//
// `clubId` is optional: pass one to wire the user into a club so
// the history card / Up Next / scoreboard rows show a club_name
// + club_code line. Tests that don't care about affiliation can
// omit it; the column is nullable.
async function insertUser({ orgId, role, fullName, clubId = null }) {
  const username = `e2e-${role}-${rand()}`;
  // bcrypt cost 4 — fine for a fixture user nobody will brute
  // force; default 12 would add ~150ms per insertion.
  const hash = await bcrypt.hash(TEST_PASSWORD, 4);
  const r = await pool.query(
    `INSERT INTO users (username, password, full_name, org_id, club_id, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
    [username, hash, fullName || `E2E ${role}`, orgId, clubId],
  );
  const userId = r.rows[0].id;
  await pool.query(
    "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)",
    [userId, orgId, role],
  );
  return { userId, username, password: TEST_PASSWORD };
}

// Insert a club under an org. Returns its id so callers can
// thread it into insertUser({ clubId }). short_code surfaces in
// the SPA as the cyan "NZL-1" pill alongside the club name in
// history cards + active-diver block; pass a 3-6 char code so it
// renders cleanly.
async function insertClub({ orgId, name, shortCode = null }) {
  const r = await pool.query(
    `INSERT INTO clubs (org_id, name, short_code)
     VALUES ($1, $2, $3) RETURNING id`,
    [orgId, name, shortCode],
  );
  return { clubId: r.rows[0].id, name, shortCode };
}

// Log in via the public API. Wraps the JSON response shape so a
// caller can pull out the token without re-implementing the
// boilerplate.
async function loginAs(request, username, password = TEST_PASSWORD) {
  const r = await request.post("/api/auth/login", {
    data: { username, password },
  });
  if (r.status() !== 200) {
    throw new Error(`login ${username}: ${r.status()} ${await r.text()}`);
  }
  return await r.json();   // { token, ... } OR { needs_totp, totp_token }
}

// Create an event via the public API. Caller passes the admin
// token; the event is created in the admin's org.
async function createEvent(request, { adminToken, ...overrides }) {
  const r = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: `E2E Event ${rand()}`,
      gender: "Female",
      number_of_judges: 5,
      total_rounds: 3,
      height: "3m",
      event_type: "individual",
      ...overrides,
    },
  });
  if (r.status() !== 201) {
    throw new Error(`create event: ${r.status()} ${await r.text()}`);
  }
  return await r.json();   // full event row
}

// Add a federation to an event's participating-org list. The host
// org is intentionally not represented in this table; callers use
// this helper for the invited / cross-federation side only.
async function addParticipatingOrg({ eventId, orgId, addedBy = null }) {
  await pool.query(
    `INSERT INTO event_participating_orgs (event_id, org_id, added_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id, org_id) DO NOTHING`,
    [eventId, orgId, addedBy],
  );
}

// Replace the panel for an event. Order matters — judge_number
// is assigned by position in the array.
async function assignJudges(request, { adminToken, eventId, judgeIds }) {
  const r = await request.post(`/api/events/${eventId}/judges`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { judgeIds },
  });
  if (r.status() !== 200) {
    throw new Error(`assign judges: ${r.status()} ${await r.text()}`);
  }
}

// Pre-populate a competitor's dive list directly. Bypasses
// /api/competitor/submit-list because that endpoint requires
// the competitor to be logged in as themselves AND the event to
// be Upcoming AND entries_close_at not reached — fine for the
// competitor-flow test that exercises that path explicitly,
// overhead for every other test.
async function insertDiveList({ eventId, competitorId, dives }) {
  for (const { round_number, dive_id } of dives) {
    await pool.query(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, competitor_id, round_number)
       DO UPDATE SET dive_id = EXCLUDED.dive_id`,
      [eventId, competitorId, round_number, dive_id],
    );
  }
}

// Look up a real dive_id from the directory. The directory is
// loaded by init.sql with ~830 World Aquatics dives — pick one
// matching the height + position so it composes sanely with
// calc_event_dive_points.
async function pickDiveId({ height = 3.0, dive_code = "101", position = "B" } = {}) {
  // dive_directory.height is numeric (e.g. 3.0, 10.0), distinct
  // from events.height which is the board_height enum ("3m",
  // "10m"). The two carry the same information; the enum is
  // for human-friendly UI labels.
  const r = await pool.query(
    `SELECT id FROM dive_directory
     WHERE height = $1::numeric AND dive_code = $2 AND position = $3::dive_position
     LIMIT 1`,
    [height, dive_code, position],
  );
  if (!r.rows.length) {
    throw new Error(`no dive_directory row for ${height}m ${dive_code}${position}`);
  }
  return r.rows[0].id;
}

// Set the event status by URL. Used to flip Upcoming → Live so
// scoring routes accept submissions.
async function setEventStatus(request, { adminToken, eventId, status }) {
  const r = await request.put(`/api/events/${eventId}/status`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { status },
  });
  if (r.status() !== 200) {
    throw new Error(`set status: ${r.status()} ${await r.text()}`);
  }
}

// Insert a coach_diver_links row. The link is scoped to an org:
// coach writes accept either the event host org or, for an invited
// cross-federation diver, the diver's participating home org.
async function linkCoach({ coachId, diverId, orgId, note = null }) {
  const r = await pool.query(
    `INSERT INTO coach_diver_links (coach_id, diver_id, org_id, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (coach_id, diver_id)
     DO UPDATE SET org_id = EXCLUDED.org_id, note = EXCLUDED.note
     RETURNING id`,
    [coachId, diverId, orgId, note],
  );
  return { linkId: r.rows[0].id };
}

// Insert one judge's score for a (event, competitor, round, dive).
// Returns the new scores.id so tests of PUT /api/scores/:id have a
// stable handle. ON CONFLICT keeps re-runs idempotent — re-submits
// with a different value update in place rather than colliding on
// the UNIQUE (event, competitor, round, judge).
async function insertScore({
  eventId, competitorId, judgeId, diveId, roundNumber, score,
}) {
  const r = await pool.query(
    `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (event_id, competitor_id, round_number, judge_id)
     DO UPDATE SET score = EXCLUDED.score, dive_id = EXCLUDED.dive_id
     RETURNING id`,
    [eventId, competitorId, judgeId, diveId, roundNumber, score],
  );
  return r.rows[0].id;
}

// Mark a user as a manager of a specific event. Score correction
// (PUT /api/scores/:id) gates non-org-admin callers on this row —
// a referee role alone isn't enough; they must also be on the
// event's manager list.
async function addEventManager({ eventId, userId }) {
  await pool.query(
    `INSERT INTO event_managers (event_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [eventId, userId],
  );
}

// Higher-level event fixture for tests that need the same shape:
// a host federation, optional invited competitor federation, one
// event, one competitor, optional coach link, optional judges, and
// optional pre-seeded dive-list rows. Returns a cleanup() hook that
// deletes every org the helper created.
async function createEventScenario(request, opts = {}) {
  const {
    crossFederation = false,
    withCoach = true,
    withDiveList = true,
    judgeCount = 0,
    event: eventOverrides = {},
    hostOrg: hostOrgOverrides = {},
    competitorOrg: competitorOrgOverrides = {},
    competitor: competitorOverrides = {},
    coach: coachOverrides = {},
    dive: diveQuery = {},
    diveListRounds = null,
  } = opts;

  const createdOrgs = [];
  const hostOrg = await createOrgAndAdmin(request, {
    orgName: "E2E Host Org",
    countryCode: "HST",
    ...hostOrgOverrides,
  });
  createdOrgs.push(hostOrg);

  let competitorOrg = hostOrg;
  if (crossFederation) {
    competitorOrg = await createOrgAndAdmin(request, {
      orgName: "E2E Guest Org",
      countryCode: "GST",
      ...competitorOrgOverrides,
    });
    createdOrgs.push(competitorOrg);
  }

  const event = await createEvent(request, {
    adminToken: hostOrg.adminToken,
    total_rounds: 1,
    number_of_judges: judgeCount || 5,
    height: "3m",
    ...eventOverrides,
  });

  if (competitorOrg.orgId !== hostOrg.orgId) {
    await addParticipatingOrg({
      eventId: event.id,
      orgId: competitorOrg.orgId,
      addedBy: hostOrg.adminId,
    });
  }

  const diveId = await pickDiveId(diveQuery);
  const competitor = await insertUser({
    orgId: competitorOrg.orgId,
    role: "diver",
    fullName: "Scenario Diver",
    ...competitorOverrides,
  });

  if (withDiveList) {
    const rounds = diveListRounds || Array.from(
      { length: Number(event.total_rounds) || 1 },
      (_, i) => i + 1,
    );
    await insertDiveList({
      eventId: event.id,
      competitorId: competitor.userId,
      dives: rounds.map((round_number) => ({ round_number, dive_id: diveId })),
    });
  }

  let coach = null;
  if (withCoach) {
    const coachUser = await insertUser({
      orgId: competitorOrg.orgId,
      role: "coach",
      fullName: "Scenario Coach",
      ...coachOverrides,
    });
    await linkCoach({
      coachId: coachUser.userId,
      diverId: competitor.userId,
      orgId: competitorOrg.orgId,
    });
    const session = await loginAs(request, coachUser.username);
    coach = { ...coachUser, token: session.token };
  }

  const judges = [];
  if (judgeCount > 0) {
    for (let i = 0; i < judgeCount; i++) {
      const judge = await insertUser({
        orgId: hostOrg.orgId,
        role: "judge",
        fullName: `Scenario Judge ${i + 1}`,
      });
      judges.push(judge);
    }
    await assignJudges(request, {
      adminToken: hostOrg.adminToken,
      eventId: event.id,
      judgeIds: judges.map((j) => j.userId),
    });
  }

  async function cleanup() {
    for (const org of [...createdOrgs].reverse()) {
      await deleteOrg(org.orgId);
    }
  }

  return {
    hostOrg,
    competitorOrg,
    event,
    diveId,
    competitor,
    coach,
    judges,
    cleanup,
  };
}

// Direct DB cleanup for a parallel-safe per-test teardown.
// Cascades through the FKs (events, dive lists, scores, etc),
// EXCEPT for users.org_id which is ON DELETE RESTRICT to keep a
// stray data-integrity bug from silently dropping a real org's
// roster in production. Delete users explicitly first so the
// downstream cascade can take care of everything else.
async function deleteOrg(orgId) {
  await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]);
  await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
}

// =============================================================
// HEADED-WATCHER HELPERS
// Small UX shims that make a --headed e2e run easier to follow
// for a human watching over the operator's shoulder. Both gated
// behind env vars so CI runs are unaffected by default.
//
//   installDialogDelay(page)
//     Wraps page.on('dialog') with a configurable dwell so
//     window.confirm() popups (Randomise, Finalise, Reset…) stay
//     visible long enough to read. Set E2E_DIALOG_HOLD_MS=5000
//     for a leisurely demo; default 0 = instant accept (CI).
//
//   installClickHighlight(page)
//     Adds an init script that draws a brief animated cyan ring
//     at every pointerdown so the watcher can see where each
//     click lands. Default ON; set E2E_HIGHLIGHT=0 to disable
//     (e.g. for screenshot-comparison tests).
// =============================================================

const DIALOG_HOLD_MS = Number(process.env.E2E_DIALOG_HOLD_MS ?? 0);
async function installDialogDelay(page) {
  page.on("dialog", async (d) => {
    if (DIALOG_HOLD_MS > 0) {
      await new Promise((r) => setTimeout(r, DIALOG_HOLD_MS));
    }
    try { await d.accept(); }
    catch { /* dialog may already be dismissed if test moved on */ }
  });
}

// Bypass the first-login RoleTour modal that fires globally on
// any dashboard mount for `coach` / `judge` / `diver` roles
// (src/components/RoleTour.vue). The tour gates on three
// localStorage keys; setting them before navigation makes the
// component skip auto-open without touching production code.
//
// Without this, every fresh-context Playwright run with a
// tour-eligible role lands on a modal that obscures the
// dashboard, and any subsequent `.event-row` / nav click times
// out at 180s. Cheap to call from every test that hits /login
// — admin / meet_manager flows are unaffected (the tour ignores
// those roles anyway).
async function bypassRoleTour(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dr_tour_seen_coach", "1");
      localStorage.setItem("dr_tour_seen_judge", "1");
      localStorage.setItem("dr_tour_seen_diver", "1");
    } catch { /* private mode / storage disabled — ignore */ }
  });
}

const HIGHLIGHT_ENABLED = process.env.E2E_HIGHLIGHT !== "0";
async function installClickHighlight(page) {
  // Always bypass the role tour, regardless of E2E_HIGHLIGHT.
  // Most tests already call installClickHighlight before navigating
  // to /login, so piggybacking here covers them without each spec
  // having to opt in.
  await bypassRoleTour(page);
  if (!HIGHLIGHT_ENABLED) return;

  // Forward [e2e-click] coordinate logs from the page to the
  // test runner stdout so a watching human can correlate "ring
  // popped at X,Y" with the test step that triggered it. Other
  // [e2e-…] prefixes (init / error) are also surfaced as a
  // debugging aid if the marker ever stops showing up.
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.startsWith("[e2e-")) {
      process.stdout.write(`  ${t}\n`);
    }
  });

  await page.addInitScript(() => {
    // ----- 1. Click listeners (DOM-free, attach NOW) -----------
    // window + document are both valid EventTargets at
    // document_start; attach here so listeners exist even
    // if the stylesheet injection below has nothing to attach
    // to yet (documentElement can be null this early).
    //
    // Belt + braces: listen to pointerdown AND mousedown on
    // BOTH window and document, all in the capture phase. A
    // single Playwright click fires both events within ~1ms;
    // dedup collapses them into one paint. The redundancy
    // matters because (a) some CSS configurations route one
    // event but not the other (pointer-events: none on the
    // target's ancestor suppresses pointerdown but not the
    // synthetic mousedown), and (b) a capture-phase listener
    // higher in the chain can stopImmediatePropagation a
    // single event type — listening on both window AND
    // document means at least one branch always fires.
    let lastTs = 0;
    const STYLE_ID = "__e2e-click-style";
    const onClick = (e) => {
      // Dedup window: 60ms is comfortably wider than any
      // pointerdown/mousedown sibling pair (~1ms apart) but
      // narrower than the fastest Playwright click cadence
      // (~150ms+ between distinct user clicks).
      if (e.timeStamp - lastTs < 60) return;
      lastTs = e.timeStamp;
      paintMarker(e.clientX, e.clientY);
    };
    for (const target of [window, document]) {
      target.addEventListener("pointerdown", onClick, true);
      target.addEventListener("mousedown",   onClick, true);
    }

    // ----- 2. Stylesheet --------------------------------------
    // Defer attachment until something exists to attach to. At
    // document_start neither documentElement nor head are
    // present yet, so installing the <style> immediately throws
    // and would silently truncate the rest of the init script.
    //
    // Marker animation tuned to be visible *from the very first
    // frame*. The previous version ramped opacity 0 → 0.95
    // over 15% of the animation (~54ms), which meant a click
    // that triggered fast navigation flashed away invisibly —
    // the page swapped before the ring crossed the visibility
    // threshold. Now opacity starts at 1, so even one painted
    // frame is enough to register the click visually.
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const host = document.head || document.documentElement;
      if (!host) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        @keyframes e2eClickRing {
          0%   { opacity: 1; transform: scale(0.6); }
          100% { opacity: 0; transform: scale(1.7); }
        }
        .__e2e-click-marker {
          position: fixed; z-index: 2147483647; pointer-events: none;
          width: 40px; height: 40px;
          margin-left: -20px; margin-top: -20px;
          border: 2px solid rgba(6, 182, 212, 1);
          border-radius: 50%;
          box-shadow:
            0 0 8px rgba(6, 182, 212, 0.7),
            inset 0 0 4px rgba(6, 182, 212, 0.45);
          animation: e2eClickRing 450ms cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
          will-change: transform, opacity;
          opacity: 1;   /* explicit pre-animation state — paints
                            on the first frame even before the
                            animation engine kicks in. */
        }
      `;
      host.appendChild(style);
    }

    function paintMarker(x, y) {
      ensureStyle();
      const target = document.body;
      if (!target) {
        // Click landed before <body> existed — log only.
        try { console.log(`[e2e-click] ${Math.round(x)},${Math.round(y)} (no body)`); } catch {}
        return;
      }
      const ring = document.createElement("div");
      ring.className = "__e2e-click-marker";
      ring.style.left = x + "px";
      ring.style.top  = y + "px";
      target.appendChild(ring);
      // Remove just after the animation finishes (450ms anim
      // + 80ms slack). Keeps the DOM lean so a fast-paced
      // click sequence doesn't accumulate stale markers.
      setTimeout(() => ring.remove(), 530);
      try { console.log(`[e2e-click] ${Math.round(x)},${Math.round(y)}`); } catch {}
    }

    // Install the stylesheet eagerly when the DOM is ready so
    // the FIRST click doesn't pay an extra paint cost.
    if (document.head || document.body) ensureStyle();
    document.addEventListener("DOMContentLoaded", ensureStyle);
  });
}

module.exports = {
  pool,
  TEST_PASSWORD,
  rand,
  openSocket,
  submitJudgeScore,
  submitPanelScores,
  collectApiErrors,
  createOrgAndAdmin,
  insertUser,
  insertClub,
  loginAs,
  createEvent,
  addParticipatingOrg,
  assignJudges,
  insertDiveList,
  pickDiveId,
  setEventStatus,
  linkCoach,
  insertScore,
  addEventManager,
  createEventScenario,
  deleteOrg,
  installDialogDelay,
  installClickHighlight,
  bypassRoleTour,
};
