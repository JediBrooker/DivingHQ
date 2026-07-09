// Authorization boundary tests for the four privileged referee
// socket events. These are socket-only writes (no HTTP equivalent),
// and a regression here would silently corrupt scores during a
// live meet:
//
//   * referee_failed_dive: flips every judge's score for that
//     dive to 0 (UPDATE scores SET score = 0 …)
//   * referee_cap_scores: caps every judge's score at cap_value
//     (UPDATE scores SET score = LEAST(score, cap) …)
//   * referee_redive: orders a redive, doesn't mutate scores rows
//     directly (the diver re-performs and submit_score overwrites
//     on the same UNIQUE key), but does insert a score_audit_log
//     snapshot capturing the action.
//   * meet_hold: pauses the event, writes
//     event_live_state.on_hold_reason. No score_audit_log row.
//
// Auth gate (all four): socketCanManageEvent(socket, event_id,
// ["referee", "meet_manager", "org_admin"]). Caller must hold one
// of those org roles, and the event has to live in the socket's org.
//
// Socket handlers don't return errors to bad callers, they just
// silently `return`. So the "wrong role" and "cross-tenant" tests
// assert the absence of side effects (DB unchanged, no broadcast
// received by a second socket subscribed to the event room) rather
// than checking for a 403-style response.
//
// Each event covered with 4 scenarios, 16 tests total:
//   1. happy path: referee fires, asserts DB mutation, broadcast,
//                  and (where applicable) an audit row.
//   2. wrong role: diver fires, asserts nothing changes and no
//                  broadcast lands on the recipient socket.
//   3. cross-tenant: referee in Org A targets event in Org B,
//                    socketCanManageEvent rejects on wrong_org.
//   4. rate limit: fire N+1 times rapidly, the (N+1)th must be
//                  silently dropped (no further mutation).
//
// Serial, because the helpers create org + users via the public
// API, which is rate-limited per-IP, so running these in parallel
// would race the auth limiter even with RATE_LIMIT_DISABLED=true.
// Each describe block uses fresh users so the in-process socket
// action rate-limiter (keyed by `${action}:${userId}`) doesn't
// bleed between tests.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

// ---------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------

// Build a single-org world with one event, one diver, one judge,
// one referee (on a referee socket), and one "spectator" socket
// connected as the admin so we can assert that broadcasts to
// `event:${event_id}` land. A score row already exists so cap and
// failed have something to mutate (and so the INSERT..SELECT into
// score_audit_log writes at least one row).
//
// The returned bundle also includes a freshly-built "wrong role"
// diver token so the wrong-role test in each block doesn't have to
// redo this setup.
async function buildRefereeWorld(request, { eventName, capValue } = {}) {
  const orgA = await setup.createOrgAndAdmin(request, {
    orgName: `RefAuthz ${setup.rand()}`,
    countryCode: "AUS",
  });

  const event = await setup.createEvent(request, {
    adminToken: orgA.adminToken,
    name: eventName || `RefAuthz Event ${setup.rand()}`,
    total_rounds: 1,
    number_of_judges: 5,
    height: "3m",
  });
  await setup.setEventStatus(request, {
    adminToken: orgA.adminToken,
    eventId: event.id,
    status: "Live",
  });

  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const competitor = await setup.insertUser({
    orgId: orgA.orgId, role: "diver", fullName: "RefAuthz Diver",
  });
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: competitor.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });

  // One judge + one seed score so failed/cap have something to
  // touch. score = 8.0 is comfortably above cap candidates (e.g.
  // 6.0) so LEAST(...) is observable, and comfortably above 0 so
  // the failed-dive zero is observable too.
  const judge = await setup.insertUser({
    orgId: orgA.orgId, role: "judge", fullName: "RefAuthz Judge",
  });
  await setup.assignJudges(request, {
    adminToken: orgA.adminToken,
    eventId: event.id,
    judgeIds: [judge.userId],
  });
  const scoreId = await setup.insertScore({
    eventId: event.id,
    competitorId: competitor.userId,
    judgeId: judge.userId,
    diveId,
    roundNumber: 1,
    score: 8.0,
  });

  // Referee with the role: socketCanManageEvent passes on the role
  // alone (the event_managers fallback only kicks in for users who
  // don't have the role).
  const referee = await setup.insertUser({
    orgId: orgA.orgId, role: "referee", fullName: "RefAuthz Referee",
  });
  const { token: refereeToken } = await setup.loginAs(request, referee.username);

  // Diver token for the wrong-role test.
  const diverUser = await setup.insertUser({
    orgId: orgA.orgId, role: "diver", fullName: "Wrong Role Diver",
  });
  const { token: diverToken } = await setup.loginAs(request, diverUser.username);

  return {
    orgA,
    event,
    diveId,
    competitor,
    judge,
    scoreId,
    referee,
    refereeToken,
    diverUser,
    diverToken,
    capValue: capValue ?? 6.0,
  };
}

// Connect a socket subscribed to event:${event_id}; returns the
// socket plus a `received` map of event-name -> array of payloads.
// Caller must `.disconnect()` it.
//
// We start listeners for the canonical broadcast names before
// subscribing so any in-flight emit lands in `received`. The
// 250ms settle delay after subscribe is the smallest cushion that
// reliably lets the join-room round-trip finish on the loopback
// socket. Without it, a fast happy-path test can fire the
// privileged event before the recipient has actually joined the
// room and miss the broadcast.
async function connectAndSubscribe(baseURL, token, eventId, eventNames) {
  const sock = await setup.openSocket(baseURL, token);
  const received = Object.fromEntries(eventNames.map((n) => [n, []]));
  for (const name of eventNames) {
    sock.on(name, (msg) => { received[name].push(msg); });
  }
  sock.emit("subscribe_event", { event_id: eventId });
  await new Promise((r) => setTimeout(r, 250));
  return { sock, received };
}

// Tiny helper: wait `ms` for any in-flight broadcast to land on
// the recipient socket. Used by the negative-case tests where we
// need to assert the absence of a broadcast. Playwright's
// expect.poll is the right tool for "wait until X is truthy", but
// for "X must stay falsy for the next 600ms" a plain sleep is simpler.
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test.describe.serial("Privileged referee socket events — authz boundary", () => {

  // -------------------------------------------------------------
  // 1. referee_failed_dive: fail a dive (scores -> 0)
  // -------------------------------------------------------------
  test.describe("referee_failed_dive", () => {
    let world;
    test.beforeAll(async ({ request }) => {
      world = await buildRefereeWorld(request, { eventName: "RefAuthz failed_dive" });
    });
    test.afterAll(async () => {
      if (world?.orgA) await setup.deleteOrg(world.orgA.orgId);
    });

    test("happy: referee fires, scores → 0, broadcast lands, audit row written", async ({ baseURL }) => {
      // Recipient socket joins the room BEFORE we emit so the
      // broadcast is captured by the `received` buffer.
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["referee_action_failed", "score_corrected"],
      );
      const refSock = await setup.openSocket(baseURL, world.refereeToken);
      try {
        refSock.emit("referee_failed_dive", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
        });

        // (a) DB mutation: score row flipped to 0.
        await expect.poll(async () => {
          const r = await setup.pool.query(
            `SELECT score FROM scores
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
            [world.event.id, world.competitor.userId, 1],
          );
          return Number(r.rows[0]?.score);
        }, { timeout: 5000, intervals: [100, 250, 500] }).toBe(0);

        // (b) Broadcast: recipient socket got both events.
        await expect.poll(
          () => recipient.received["referee_action_failed"].length,
          { timeout: 3000, intervals: [100, 250] },
        ).toBeGreaterThan(0);
        await expect.poll(
          () => recipient.received["score_corrected"].length,
          { timeout: 3000, intervals: [100, 250] },
        ).toBeGreaterThan(0);
        expect(recipient.received["score_corrected"][0].reason).toBe("referee:failed");

        // (c) Audit row: applyRefereeAction writes one
        // score_audit_log row per existing scores row. We seeded
        // one judge -> one audit row.
        const audit = await setup.pool.query(
          `SELECT action, old_score, new_score, reason, actor_user_id
             FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
            ORDER BY created_at DESC LIMIT 1`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(audit.rows[0].action).toBe("update");
        expect(Number(audit.rows[0].old_score)).toBe(8.0);
        expect(Number(audit.rows[0].new_score)).toBe(0);
        expect(audit.rows[0].reason).toBe("referee:failed");
        expect(audit.rows[0].actor_user_id).toBe(world.referee.userId);
      } finally {
        refSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("wrong role: diver fires — no mutation, no broadcast, no audit row", async ({ baseURL, request }) => {
      // Restore the seeded score to 8.0 so we can detect a stray
      // mutation. The happy-path test left it at 0.
      await setup.pool.query(
        `UPDATE scores SET score = 8.0
          WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
        [world.event.id, world.competitor.userId, 1],
      );
      const auditBaseline = await setup.pool.query(
        `SELECT COUNT(*)::int AS n FROM score_audit_log
          WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
        [world.event.id, world.competitor.userId, 1],
      );

      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["referee_action_failed", "score_corrected"],
      );
      const badSock = await setup.openSocket(baseURL, world.diverToken);
      try {
        badSock.emit("referee_failed_dive", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
        });
        await sleep(600);

        // Score unchanged.
        const r = await setup.pool.query(
          `SELECT score FROM scores
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(Number(r.rows[0].score)).toBe(8.0);

        // No broadcast.
        expect(recipient.received["referee_action_failed"]).toHaveLength(0);
        expect(recipient.received["score_corrected"]).toHaveLength(0);

        // No new audit row.
        const auditAfter = await setup.pool.query(
          `SELECT COUNT(*)::int AS n FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(auditAfter.rows[0].n).toBe(auditBaseline.rows[0].n);
      } finally {
        badSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("cross-tenant: referee in Org B targets event in Org A — no mutation", async ({ baseURL, request }) => {
      const orgB = await setup.createOrgAndAdmin(request, {
        orgName: `RefAuthz B ${setup.rand()}`,
        countryCode: "NZL",
      });
      try {
        const foreignRef = await setup.insertUser({
          orgId: orgB.orgId, role: "referee", fullName: "Foreign Referee",
        });
        const { token: foreignToken } = await setup.loginAs(request, foreignRef.username);

        // Reset score so any mutation is observable.
        await setup.pool.query(
          `UPDATE scores SET score = 8.0
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );
        const auditBaseline = await setup.pool.query(
          `SELECT COUNT(*)::int AS n FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );

        const recipient = await connectAndSubscribe(
          baseURL, world.refereeToken, world.event.id,
          ["referee_action_failed", "score_corrected"],
        );
        const evilSock = await setup.openSocket(baseURL, foreignToken);
        try {
          evilSock.emit("referee_failed_dive", {
            event_id: world.event.id,
            competitor_id: world.competitor.userId,
            round_number: 1,
          });
          await sleep(600);

          const r = await setup.pool.query(
            `SELECT score FROM scores
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
            [world.event.id, world.competitor.userId, 1],
          );
          expect(Number(r.rows[0].score)).toBe(8.0);

          expect(recipient.received["referee_action_failed"]).toHaveLength(0);
          expect(recipient.received["score_corrected"]).toHaveLength(0);

          const auditAfter = await setup.pool.query(
            `SELECT COUNT(*)::int AS n FROM score_audit_log
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
            [world.event.id, world.competitor.userId, 1],
          );
          expect(auditAfter.rows[0].n).toBe(auditBaseline.rows[0].n);
        } finally {
          evilSock.disconnect();
          recipient.sock.disconnect();
        }
      } finally {
        await setup.deleteOrg(orgB.orgId);
      }
    });

    test("rate limit: 30 fires pass, the 31st is silently dropped", async ({ baseURL, request }) => {
      // Use a fresh referee so the in-process limiter (keyed by
      // `referee_action:${userId}`) starts at zero. The happy-path
      // and cross-tenant tests above used world.refereeToken, which
      // already consumed slots, so a new user is the cleanest reset.
      const burstReferee = await setup.insertUser({
        orgId: world.orgA.orgId, role: "referee", fullName: "Burst Referee F",
      });
      const { token: burstToken } = await setup.loginAs(request, burstReferee.username);

      // Count accepted actions via the room broadcast rather than the
      // score value. The server emits exactly one `referee_action_failed`
      // per fire that clears the limiter, and stays silent on the
      // dropped one. The score saturates (the first fire flips it to 0
      // and the other 29 are no-ops), so polling the score can't tell
      // "1 processed" from "30 processed" - which is what made the old
      // reset-and-recheck version flakey under CI load. Waiting for all
      // 30 broadcasts before firing #31 removes the race entirely.
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id, ["referee_action_failed"],
      );
      const burstSock = await setup.openSocket(baseURL, burstToken);
      try {
        for (let i = 0; i < 30; i++) {
          burstSock.emit("referee_failed_dive", {
            event_id: world.event.id,
            competitor_id: world.competitor.userId,
            round_number: 1,
          });
        }
        // All 30 must clear the limiter (and broadcast) before #31.
        await expect.poll(
          () => recipient.received["referee_action_failed"].length,
          { timeout: 5000, intervals: [100, 250, 500] },
        ).toBe(30);

        // #31 is over the 30/60s limit → silently dropped: no further
        // broadcast lands.
        burstSock.emit("referee_failed_dive", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
        });
        await sleep(600);
        expect(recipient.received["referee_action_failed"]).toHaveLength(30);
      } finally {
        burstSock.disconnect();
        recipient.sock.disconnect();
      }
    });
  });

  // -------------------------------------------------------------
  // 2. referee_cap_scores: cap scores at cap_value
  // -------------------------------------------------------------
  test.describe("referee_cap_scores", () => {
    let world;
    test.beforeAll(async ({ request }) => {
      world = await buildRefereeWorld(request, {
        eventName: "RefAuthz cap_scores",
        capValue: 6.0,
      });
    });
    test.afterAll(async () => {
      if (world?.orgA) await setup.deleteOrg(world.orgA.orgId);
    });

    test("happy: referee caps at 6.0, score 8.0 → 6.0, broadcast + audit row land", async ({ baseURL }) => {
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["referee_action_cap", "score_corrected"],
      );
      const refSock = await setup.openSocket(baseURL, world.refereeToken);
      try {
        refSock.emit("referee_cap_scores", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
          cap_value: 6.0,
        });

        // (a) DB mutation: 8.0 → LEAST(8.0, 6.0) = 6.0.
        await expect.poll(async () => {
          const r = await setup.pool.query(
            `SELECT score FROM scores
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
            [world.event.id, world.competitor.userId, 1],
          );
          return Number(r.rows[0]?.score);
        }, { timeout: 5000, intervals: [100, 250, 500] }).toBe(6.0);

        // (b) Broadcast.
        await expect.poll(
          () => recipient.received["referee_action_cap"].length,
          { timeout: 3000, intervals: [100, 250] },
        ).toBeGreaterThan(0);
        await expect.poll(
          () => recipient.received["score_corrected"].length,
          { timeout: 3000, intervals: [100, 250] },
        ).toBeGreaterThan(0);
        expect(recipient.received["score_corrected"][0].reason).toMatch(/^referee:cap/);

        // (c) Audit row: reason captures the cap value.
        const audit = await setup.pool.query(
          `SELECT action, old_score, new_score, reason, actor_user_id
             FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
            ORDER BY created_at DESC LIMIT 1`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(audit.rows[0].action).toBe("update");
        expect(Number(audit.rows[0].old_score)).toBe(8.0);
        expect(Number(audit.rows[0].new_score)).toBe(6.0);
        expect(audit.rows[0].reason).toBe("referee:cap(6)");
        expect(audit.rows[0].actor_user_id).toBe(world.referee.userId);
      } finally {
        refSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("wrong role: diver fires cap — no mutation, no broadcast", async ({ baseURL }) => {
      // After the happy path score = 6.0. Bump it back to 8.0 so a
      // stray cap would observably push it down.
      await setup.pool.query(
        `UPDATE scores SET score = 8.0
          WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
        [world.event.id, world.competitor.userId, 1],
      );
      const auditBaseline = await setup.pool.query(
        `SELECT COUNT(*)::int AS n FROM score_audit_log
          WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
        [world.event.id, world.competitor.userId, 1],
      );

      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["referee_action_cap", "score_corrected"],
      );
      const badSock = await setup.openSocket(baseURL, world.diverToken);
      try {
        badSock.emit("referee_cap_scores", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
          cap_value: 2.0,
        });
        await sleep(600);

        const r = await setup.pool.query(
          `SELECT score FROM scores
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(Number(r.rows[0].score)).toBe(8.0);

        expect(recipient.received["referee_action_cap"]).toHaveLength(0);
        expect(recipient.received["score_corrected"]).toHaveLength(0);

        const auditAfter = await setup.pool.query(
          `SELECT COUNT(*)::int AS n FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(auditAfter.rows[0].n).toBe(auditBaseline.rows[0].n);
      } finally {
        badSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("cross-tenant: referee in Org B targets cap on Org A's event — no mutation", async ({ baseURL, request }) => {
      const orgB = await setup.createOrgAndAdmin(request, {
        orgName: `RefAuthz B cap ${setup.rand()}`,
        countryCode: "NZL",
      });
      try {
        const foreignRef = await setup.insertUser({
          orgId: orgB.orgId, role: "referee", fullName: "Foreign Cap Referee",
        });
        const { token: foreignToken } = await setup.loginAs(request, foreignRef.username);

        await setup.pool.query(
          `UPDATE scores SET score = 8.0
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
          [world.event.id, world.competitor.userId, 1],
        );

        const recipient = await connectAndSubscribe(
          baseURL, world.refereeToken, world.event.id,
          ["referee_action_cap", "score_corrected"],
        );
        const evilSock = await setup.openSocket(baseURL, foreignToken);
        try {
          evilSock.emit("referee_cap_scores", {
            event_id: world.event.id,
            competitor_id: world.competitor.userId,
            round_number: 1,
            cap_value: 2.0,
          });
          await sleep(600);

          const r = await setup.pool.query(
            `SELECT score FROM scores
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3`,
            [world.event.id, world.competitor.userId, 1],
          );
          expect(Number(r.rows[0].score)).toBe(8.0);

          expect(recipient.received["referee_action_cap"]).toHaveLength(0);
          expect(recipient.received["score_corrected"]).toHaveLength(0);
        } finally {
          evilSock.disconnect();
          recipient.sock.disconnect();
        }
      } finally {
        await setup.deleteOrg(orgB.orgId);
      }
    });

    test("rate limit: 30 cap fires pass, the 31st is silently dropped", async ({ baseURL, request }) => {
      const burstReferee = await setup.insertUser({
        orgId: world.orgA.orgId, role: "referee", fullName: "Burst Referee C",
      });
      const { token: burstToken } = await setup.loginAs(request, burstReferee.username);

      // Count accepted caps via the room broadcast rather than the
      // score value. The server emits one `referee_action_cap` per fire
      // that clears the limiter, and nothing on the dropped one. The
      // score saturates (first cap drops 8.0 -> 6.0, the rest are
      // no-ops), so a score poll can't distinguish 1 from 30 processed.
      // That's the cause of the old flakiness. Waiting for all 30
      // broadcasts before firing #31 removes the race.
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id, ["referee_action_cap"],
      );
      const burstSock = await setup.openSocket(baseURL, burstToken);
      try {
        for (let i = 0; i < 30; i++) {
          burstSock.emit("referee_cap_scores", {
            event_id: world.event.id,
            competitor_id: world.competitor.userId,
            round_number: 1,
            cap_value: 6.0,
          });
        }
        // All 30 must clear the limiter (and broadcast) before #31.
        await expect.poll(
          () => recipient.received["referee_action_cap"].length,
          { timeout: 5000, intervals: [100, 250, 500] },
        ).toBe(30);

        // #31 is over the 30/60s limit → silently dropped: no further
        // broadcast lands.
        burstSock.emit("referee_cap_scores", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
          cap_value: 6.0,
        });
        await sleep(600);
        expect(recipient.received["referee_action_cap"]).toHaveLength(30);
      } finally {
        burstSock.disconnect();
        recipient.sock.disconnect();
      }
    });
  });

  // -------------------------------------------------------------
  // 3. referee_redive: order a redive
  //
  // The route does not mutate scores rows directly (the diver
  // re-performs and submit_score overwrites on the UNIQUE key). It
  // does write a score_audit_log row per existing scores row, and
  // broadcasts `referee_action_redive` to the event room.
  //
  // So our DB-side assertion is "score_audit_log gained a row
  // with reason='referee:redive'", not "scores row deleted".
  // -------------------------------------------------------------
  test.describe("referee_redive", () => {
    let world;
    test.beforeAll(async ({ request }) => {
      world = await buildRefereeWorld(request, { eventName: "RefAuthz redive" });
    });
    test.afterAll(async () => {
      if (world?.orgA) await setup.deleteOrg(world.orgA.orgId);
    });

    test("happy: referee fires redive, audit row with reason='referee:redive' lands, broadcast received", async ({ baseURL }) => {
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["referee_action_redive"],
      );
      const refSock = await setup.openSocket(baseURL, world.refereeToken);
      try {
        refSock.emit("referee_redive", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
        });

        // Audit row lands with the redive reason.
        await expect.poll(async () => {
          const r = await setup.pool.query(
            `SELECT COUNT(*)::int AS n FROM score_audit_log
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
                AND reason = 'referee:redive'`,
            [world.event.id, world.competitor.userId, 1],
          );
          return r.rows[0].n;
        }, { timeout: 5000, intervals: [100, 250, 500] }).toBeGreaterThan(0);

        // Broadcast received.
        await expect.poll(
          () => recipient.received["referee_action_redive"].length,
          { timeout: 3000, intervals: [100, 250] },
        ).toBeGreaterThan(0);
      } finally {
        refSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("wrong role: diver fires — no audit row, no broadcast", async ({ baseURL }) => {
      const before = await setup.pool.query(
        `SELECT COUNT(*)::int AS n FROM score_audit_log
          WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
            AND reason = 'referee:redive'`,
        [world.event.id, world.competitor.userId, 1],
      );

      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["referee_action_redive"],
      );
      const badSock = await setup.openSocket(baseURL, world.diverToken);
      try {
        badSock.emit("referee_redive", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
        });
        await sleep(600);

        const after = await setup.pool.query(
          `SELECT COUNT(*)::int AS n FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
              AND reason = 'referee:redive'`,
          [world.event.id, world.competitor.userId, 1],
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
        expect(recipient.received["referee_action_redive"]).toHaveLength(0);
      } finally {
        badSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("cross-tenant: referee in Org B targets redive on Org A's event — no audit row", async ({ baseURL, request }) => {
      const orgB = await setup.createOrgAndAdmin(request, {
        orgName: `RefAuthz B rd ${setup.rand()}`,
        countryCode: "NZL",
      });
      try {
        const foreignRef = await setup.insertUser({
          orgId: orgB.orgId, role: "referee", fullName: "Foreign RD Referee",
        });
        const { token: foreignToken } = await setup.loginAs(request, foreignRef.username);

        const before = await setup.pool.query(
          `SELECT COUNT(*)::int AS n FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
              AND reason = 'referee:redive'`,
          [world.event.id, world.competitor.userId, 1],
        );

        const recipient = await connectAndSubscribe(
          baseURL, world.refereeToken, world.event.id,
          ["referee_action_redive"],
        );
        const evilSock = await setup.openSocket(baseURL, foreignToken);
        try {
          evilSock.emit("referee_redive", {
            event_id: world.event.id,
            competitor_id: world.competitor.userId,
            round_number: 1,
          });
          await sleep(600);

          const after = await setup.pool.query(
            `SELECT COUNT(*)::int AS n FROM score_audit_log
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
                AND reason = 'referee:redive'`,
            [world.event.id, world.competitor.userId, 1],
          );
          expect(after.rows[0].n).toBe(before.rows[0].n);
          expect(recipient.received["referee_action_redive"]).toHaveLength(0);
        } finally {
          evilSock.disconnect();
          recipient.sock.disconnect();
        }
      } finally {
        await setup.deleteOrg(orgB.orgId);
      }
    });

    test("rate limit: 30 redive fires pass, the 31st is silently dropped", async ({ baseURL, request }) => {
      const burstReferee = await setup.insertUser({
        orgId: world.orgA.orgId, role: "referee", fullName: "Burst Referee RD",
      });
      const { token: burstToken } = await setup.loginAs(request, burstReferee.username);

      const before = await setup.pool.query(
        `SELECT COUNT(*)::int AS n FROM score_audit_log
          WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
            AND reason = 'referee:redive'
            AND actor_user_id = $4`,
        [world.event.id, world.competitor.userId, 1, burstReferee.userId],
      );

      const burstSock = await setup.openSocket(baseURL, burstToken);
      try {
        for (let i = 0; i < 30; i++) {
          burstSock.emit("referee_redive", {
            event_id: world.event.id,
            competitor_id: world.competitor.userId,
            round_number: 1,
          });
        }

        // Each fire writes one audit row (one judge → one row per
        // fire). Wait for the 30 to land.
        await expect.poll(async () => {
          const r = await setup.pool.query(
            `SELECT COUNT(*)::int AS n FROM score_audit_log
              WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
                AND reason = 'referee:redive'
                AND actor_user_id = $4`,
            [world.event.id, world.competitor.userId, 1, burstReferee.userId],
          );
          return r.rows[0].n;
        }, { timeout: 5000, intervals: [100, 250, 500] }).toBe(before.rows[0].n + 30);

        // Fire #31, should be silently dropped.
        burstSock.emit("referee_redive", {
          event_id: world.event.id,
          competitor_id: world.competitor.userId,
          round_number: 1,
        });
        await sleep(600);

        const after = await setup.pool.query(
          `SELECT COUNT(*)::int AS n FROM score_audit_log
            WHERE event_id = $1 AND competitor_id = $2 AND round_number = $3
              AND reason = 'referee:redive'
              AND actor_user_id = $4`,
          [world.event.id, world.competitor.userId, 1, burstReferee.userId],
        );
        expect(after.rows[0].n).toBe(before.rows[0].n + 30);
      } finally {
        burstSock.disconnect();
      }
    });
  });

  // -------------------------------------------------------------
  // 4. meet_hold: pause the meet (e.g. equipment fault, weather)
  //
  // Writes event_live_state.on_hold_reason via persistMeetHold.
  // Broadcasts `meet_held` to the event room. No score_audit_log
  // row, since this isn't a score mutation, it's a meet-state change.
  // Rate-limit key: `meet_hold:${userId}`, limit 10/min.
  // -------------------------------------------------------------
  test.describe("meet_hold", () => {
    let world;
    test.beforeAll(async ({ request }) => {
      world = await buildRefereeWorld(request, { eventName: "RefAuthz meet_hold" });
    });
    test.afterAll(async () => {
      if (world?.orgA) await setup.deleteOrg(world.orgA.orgId);
    });

    test("happy: referee holds the meet, event_live_state.on_hold_reason set, broadcast lands", async ({ baseURL }) => {
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["meet_held"],
      );
      const refSock = await setup.openSocket(baseURL, world.refereeToken);
      try {
        refSock.emit("meet_hold", {
          event_id: world.event.id,
          reason: "Lightning in area",
        });

        // (a) DB state: on_hold_reason persisted.
        await expect.poll(async () => {
          const r = await setup.pool.query(
            `SELECT on_hold_reason FROM event_live_state WHERE event_id = $1`,
            [world.event.id],
          );
          return r.rows[0]?.on_hold_reason;
        }, { timeout: 5000, intervals: [100, 250, 500] }).toBe("Lightning in area");

        // (b) Broadcast.
        await expect.poll(
          () => recipient.received["meet_held"].length,
          { timeout: 3000, intervals: [100, 250] },
        ).toBeGreaterThan(0);
        expect(recipient.received["meet_held"][0].reason).toBe("Lightning in area");
      } finally {
        refSock.disconnect();
        recipient.sock.disconnect();
        // Clean up the hold so it doesn't leak into other tests
        // here, just in case (no cross-suite leak since each
        // describe builds its own event, but the meet_resume
        // coverage path lives in a separate spec file).
        await setup.pool.query(
          `UPDATE event_live_state SET on_hold_reason = NULL, hold_since = NULL
            WHERE event_id = $1`,
          [world.event.id],
        );
      }
    });

    test("wrong role: diver fires meet_hold — on_hold_reason stays null, no broadcast", async ({ baseURL }) => {
      // Clear any residual hold state from the happy path.
      await setup.pool.query(
        `UPDATE event_live_state SET on_hold_reason = NULL, hold_since = NULL
          WHERE event_id = $1`,
        [world.event.id],
      );

      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id,
        ["meet_held"],
      );
      const badSock = await setup.openSocket(baseURL, world.diverToken);
      try {
        badSock.emit("meet_hold", {
          event_id: world.event.id,
          reason: "Should not land",
        });
        await sleep(600);

        const r = await setup.pool.query(
          `SELECT on_hold_reason FROM event_live_state WHERE event_id = $1`,
          [world.event.id],
        );
        // Row may not exist yet, or it may exist with on_hold_reason
        // = null. Both count as "no hold", the bug we'd catch is a
        // non-null reason.
        expect(r.rows[0]?.on_hold_reason ?? null).toBeNull();
        expect(recipient.received["meet_held"]).toHaveLength(0);
      } finally {
        badSock.disconnect();
        recipient.sock.disconnect();
      }
    });

    test("cross-tenant: referee in Org B holds Org A's event — on_hold_reason stays null", async ({ baseURL, request }) => {
      const orgB = await setup.createOrgAndAdmin(request, {
        orgName: `RefAuthz B mh ${setup.rand()}`,
        countryCode: "NZL",
      });
      try {
        const foreignRef = await setup.insertUser({
          orgId: orgB.orgId, role: "referee", fullName: "Foreign MH Referee",
        });
        const { token: foreignToken } = await setup.loginAs(request, foreignRef.username);

        await setup.pool.query(
          `UPDATE event_live_state SET on_hold_reason = NULL, hold_since = NULL
            WHERE event_id = $1`,
          [world.event.id],
        );

        const recipient = await connectAndSubscribe(
          baseURL, world.refereeToken, world.event.id,
          ["meet_held"],
        );
        const evilSock = await setup.openSocket(baseURL, foreignToken);
        try {
          evilSock.emit("meet_hold", {
            event_id: world.event.id,
            reason: "cross-tenant hold attempt",
          });
          await sleep(600);

          const r = await setup.pool.query(
            `SELECT on_hold_reason FROM event_live_state WHERE event_id = $1`,
            [world.event.id],
          );
          expect(r.rows[0]?.on_hold_reason ?? null).toBeNull();
          expect(recipient.received["meet_held"]).toHaveLength(0);
        } finally {
          evilSock.disconnect();
          recipient.sock.disconnect();
        }
      } finally {
        await setup.deleteOrg(orgB.orgId);
      }
    });

    test("rate limit: 10 hold fires pass, the 11th is silently dropped", async ({ baseURL, request }) => {
      // meet_hold limiter is 10/min, separately keyed from
      // referee_action.
      const burstReferee = await setup.insertUser({
        orgId: world.orgA.orgId, role: "referee", fullName: "Burst Referee MH",
      });
      const { token: burstToken } = await setup.loginAs(request, burstReferee.username);

      // Count accepted holds via the `meet_held` room broadcast, not
      // the persisted on_hold_reason. persistMeetHold is fire-and-forget
      // (lib/live-state.js doesn't await the pool.query), so the DB
      // row's reason can't be pinned, and racing those async writes is
      // exactly what made the old poll-the-reason version fragile. The
      // server emits one `meet_held` synchronously per hold that clears
      // the limiter and nothing on the dropped one, so the broadcast
      // count is the exact "how many passed the limiter" signal.
      // (subscribe_event only joins the room; the meet_held replay lives
      // in the separate get_meet_hold handler, so the recipient sees
      // only this burst's broadcasts.)
      const recipient = await connectAndSubscribe(
        baseURL, world.refereeToken, world.event.id, ["meet_held"],
      );
      const burstSock = await setup.openSocket(baseURL, burstToken);
      try {
        for (let i = 0; i < 10; i++) {
          burstSock.emit("meet_hold", {
            event_id: world.event.id,
            reason: `hold-${i}`,
          });
        }
        // All 10 must clear the limiter (and broadcast) before #11.
        await expect.poll(
          () => recipient.received["meet_held"].length,
          { timeout: 5000, intervals: [100, 250, 500] },
        ).toBe(10);

        // #11 is over the 10/min limit → silently dropped: no further
        // broadcast lands, and the sentinel reason never enters the
        // broadcast stream.
        burstSock.emit("meet_hold", {
          event_id: world.event.id,
          reason: "should-not-land",
        });
        await sleep(600);
        expect(recipient.received["meet_held"]).toHaveLength(10);
        expect(
          recipient.received["meet_held"].some((m) => m.reason === "should-not-land"),
        ).toBe(false);
      } finally {
        burstSock.disconnect();
        recipient.sock.disconnect();
      }
    });
  });
});
