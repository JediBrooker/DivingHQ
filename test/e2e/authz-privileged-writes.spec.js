// Authorization boundary tests for privileged writes.
//
// These endpoints all carry HIGH blast-radius (rewriting a score,
// scratching a diver, submitting a dive list on someone's behalf),
// and the audit notes call them out as the surfaces an attacker
// would go for first. Before this spec landed there was zero
// e2e coverage of the role + tenant gates, so a regression in
// requireOrgRole / requireCoachLink could ship undetected.
//
// Each describe block exercises:
//   * happy path with a side-effect assertion (audit row,
//     socket event, row-count change, etc.), proving the gate
//     isn't accidentally over-permissive
//   * wrong-role: a user with no relevant role gets 403
//   * cross-tenant: a same-role caller in another org gets 403
//   * (coach-only) cross-federation: a home-federation coach can
//     write only when the diver's home org is on the event's
//     participating list; wrong-org links still fail closed
//
// Serial, because the helpers create org + users via the public
// API which is rate-limited per-IP. Running these in parallel
// would race the auth limiter even with RATE_LIMIT_DISABLED=true.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

function auth(token) { return { Authorization: `Bearer ${token}` }; }

// Spin up a self-contained world for a single endpoint: two orgs
// (so cross-tenant assertions are cheap), an event in Org A with
// a Live status and a real dive list + scored judge, plus a
// referee, a diver-role user, and a foreign-org referee.
//
// Returned bundle is everything a describe block needs to compose
// its own assertions. Test teardown deletes both orgs when it's done.
async function buildTwoOrgFixture(request) {
  const orgA = await setup.createOrgAndAdmin(request, { orgName: "Authz E2E A", countryCode: "AUS" });
  const orgB = await setup.createOrgAndAdmin(request, { orgName: "Authz E2E B", countryCode: "NZL" });
  return { orgA, orgB };
}

test.describe.serial("Privileged writes — authz boundary", () => {
  // -------------------------------------------------------------
  // 1. PUT /api/scores/:id: referee/meet-manager can amend a
  //    finalized score within their org + event. Diver hitting it
  //    gets 403; referee from another org gets 403.
  // -------------------------------------------------------------
  test.describe("PUT /api/scores/:id score correction", () => {
    let orgA, orgB;
    let event, scoreId, refereeToken;
    let diverToken, foreignRefereeToken;

    test.beforeAll(async ({ request }) => {
      ({ orgA, orgB } = await buildTwoOrgFixture(request));

      event = await setup.createEvent(request, {
        adminToken: orgA.adminToken,
        name: "Authz Score Correction",
        total_rounds: 1,
        number_of_judges: 5,
        height: "3m",
      });
      const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
      const competitor = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Score Diver" });
      await setup.insertDiveList({
        eventId: event.id,
        competitorId: competitor.userId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });

      // One judge + one score row gives us a stable scoreId to amend.
      const judge = await setup.insertUser({ orgId: orgA.orgId, role: "judge", fullName: "Score Judge" });
      await setup.assignJudges(request, { adminToken: orgA.adminToken, eventId: event.id, judgeIds: [judge.userId] });
      scoreId = await setup.insertScore({
        eventId: event.id, competitorId: competitor.userId,
        judgeId: judge.userId, diveId, roundNumber: 1, score: 7.0,
      });

      // Org A's referee is added to the event manager list, since the
      // per-event check beyond requireOrgRole is what gates this.
      const referee = await setup.insertUser({ orgId: orgA.orgId, role: "referee", fullName: "Authz Referee" });
      await setup.addEventManager({ eventId: event.id, userId: referee.userId });
      ({ token: refereeToken } = await setup.loginAs(request, referee.username));

      const diver = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Authz Diver" });
      ({ token: diverToken } = await setup.loginAs(request, diver.username));

      const foreignReferee = await setup.insertUser({ orgId: orgB.orgId, role: "referee", fullName: "Foreign Referee" });
      ({ token: foreignRefereeToken } = await setup.loginAs(request, foreignReferee.username));
    });

    test.afterAll(async () => {
      if (orgA) await setup.deleteOrg(orgA.orgId);
      if (orgB) await setup.deleteOrg(orgB.orgId);
    });

    test("happy: referee on the event amends the score, audit row + socket broadcast", async ({ request, baseURL }) => {
      // Subscribe BEFORE the PUT so we don't miss the broadcast.
      // Socket timing is non-deterministic, so we lean on expect.poll
      // against a received-flag set in the callback.
      const sock = await setup.openSocket(baseURL, refereeToken);
      const received = [];
      sock.emit("subscribe_event", { event_id: event.id });
      sock.on("score_corrected", (msg) => { received.push(msg); });

      try {
        const r = await request.put(`/api/scores/${scoreId}`, {
          headers: auth(refereeToken),
          data: { score: 8.5, reason: "Judge typo per protest" },
        });
        expect(r.status()).toBe(200);
        const body = await r.json();
        expect(body.ok).toBe(true);
        expect(Number(body.new_score)).toBe(8.5);

        await expect.poll(() => received.length, {
          timeout: 5000, intervals: [100, 250, 500],
        }).toBeGreaterThan(0);
        expect(received[0].score_id).toBe(scoreId);
        expect(Number(received[0].new_score)).toBe(8.5);
      } finally {
        sock.disconnect();
      }

      const audit = await setup.pool.query(
        `SELECT action, old_score, new_score, reason, actor_user_id
           FROM score_audit_log
          WHERE score_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [scoreId],
      );
      expect(audit.rows[0].action).toBe("update");
      expect(Number(audit.rows[0].old_score)).toBe(7.0);
      expect(Number(audit.rows[0].new_score)).toBe(8.5);
      expect(audit.rows[0].reason).toBe("Judge typo per protest");
    });

    test("wrong role: diver gets 403", async ({ request }) => {
      const r = await request.put(`/api/scores/${scoreId}`, {
        headers: auth(diverToken),
        data: { score: 6.0, reason: "should be blocked" },
      });
      expect(r.status()).toBe(403);
    });

    test("cross-tenant: referee from Org B gets 403", async ({ request }) => {
      const r = await request.put(`/api/scores/${scoreId}`, {
        headers: auth(foreignRefereeToken),
        data: { score: 6.0, reason: "cross-tenant attempt" },
      });
      expect(r.status()).toBe(403);
      const body = await r.json();
      expect(body.error).toMatch(/other organisations|not a manager/i);
    });

    test("same-org referee NOT on this event gets 403", async ({ request }) => {
      // Referee role in the right org but no event_managers row →
      // requireOrgRole passes, per-event check fails.
      const stray = await setup.insertUser({
        orgId: orgA.orgId, role: "referee", fullName: "Stray Referee",
      });
      const { token: strayToken } = await setup.loginAs(request, stray.username);
      const r = await request.put(`/api/scores/${scoreId}`, {
        headers: auth(strayToken),
        data: { score: 6.0, reason: "no event_managers row" },
      });
      expect(r.status()).toBe(403);
      expect((await r.json()).error).toMatch(/not a manager/i);
    });
  });

  // -------------------------------------------------------------
  // 2. POST /api/coach/dive-lists/:event_id/:diver_id: coach
  //    submits on behalf of a linked diver. Multi-tenant gate at
  //    requireCoachLink (link.org_id must match event.org_id).
  // -------------------------------------------------------------
  test.describe("POST /api/coach/dive-lists submit on behalf", () => {
    let orgA, orgB;
    let event, diver, diveId, coachOkToken, coachOkUserId;
    let stranger; // coach with no link
    let wrongOrgCoachToken;

    test.beforeAll(async ({ request }) => {
      ({ orgA, orgB } = await buildTwoOrgFixture(request));

      event = await setup.createEvent(request, {
        adminToken: orgA.adminToken,
        name: "Authz Coach Submit",
        total_rounds: 1,
        number_of_judges: 5,
        height: "3m",
      });
      diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
      diver = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Submit Diver" });

      // The legitimate coach: link.org_id matches the event's org.
      const coach = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Submit Coach OK" });
      await setup.linkCoach({ coachId: coach.userId, diverId: diver.userId, orgId: orgA.orgId });
      coachOkUserId = coach.userId;
      ({ token: coachOkToken } = await setup.loginAs(request, coach.username));

      // Stranger coach: same org, no link.
      stranger = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Stranger Coach" });

      // Wrong-org coach: link exists, but it's pinned to Org B (a
      // bogus link the operator over-shared). Even though the link
      // row exists, the coach.js gate scopes the lookup by event
      // org or the diver's participating home org → no match → 403.
      const wrongOrg = await setup.insertUser({ orgId: orgB.orgId, role: "coach", fullName: "Wrong Org Coach" });
      await setup.linkCoach({ coachId: wrongOrg.userId, diverId: diver.userId, orgId: orgB.orgId });
      ({ token: wrongOrgCoachToken } = await setup.loginAs(request, wrongOrg.username));
    });

    test.afterAll(async () => {
      if (orgA) await setup.deleteOrg(orgA.orgId);
      if (orgB) await setup.deleteOrg(orgB.orgId);
    });

    test("host-org happy: linked coach submits a list — row count matches + stale rounds cleared", async ({ request }) => {
      // Pre-seed an orphan round 2. We then submit only round 1
      // → the dive-list-submit helper should DELETE the stale R2
      // row so the diver isn't left with a ghost round.
      await setup.pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id)
         VALUES ($1, $2, 2, $3)
         ON CONFLICT (event_id, competitor_id, round_number) DO UPDATE SET dive_id = EXCLUDED.dive_id`,
        [event.id, diver.userId, diveId],
      );

      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(coachOkToken),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      expect(r.status()).toBe(200);

      const rows = await setup.pool.query(
        `SELECT round_number FROM competitor_dive_lists
          WHERE event_id = $1 AND competitor_id = $2 AND withdrawn_at IS NULL
          ORDER BY round_number`,
        [event.id, diver.userId],
      );
      expect(rows.rows.map((x) => x.round_number)).toEqual([1]);

      // Audit row landed with the full payload: actor_id, org_id,
      // and metadata are the fields that silently NULLed before
      // commit 96caa22 fixed the recordAudit field-name mismatch.
      const audit = await setup.pool.query(
        `SELECT actor_id, org_id, entity_type, entity_id, metadata
           FROM audit_log
          WHERE entity_type = 'dive_list'
            AND entity_id = $1
            AND action = 'coach.submit_dive_list'
          ORDER BY created_at DESC LIMIT 1`,
        [diver.userId],
      );
      const row = audit.rows[0];
      expect(row?.actor_id).toBe(coachOkUserId);
      expect(row?.org_id).toBe(orgA.orgId);
      expect(row?.entity_type).toBe("dive_list");
      expect(row?.entity_id).toBe(diver.userId);
      expect(row?.metadata).toMatchObject({
        event_id: event.id,
        coach_id: coachOkUserId,
        diver_id: diver.userId,
        dive_count: 1,
      });
    });

    test("no link: stranger coach gets 403", async ({ request }) => {
      const { token } = await setup.loginAs(request, stranger.username);
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(token),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      expect(r.status()).toBe(403);
      expect((await r.json()).error).toMatch(/linked/i);
    });

    test("wrong-org link: coach with link in Org B can't touch Org A event — regression gate", async ({ request }) => {
      // The coach DOES have a coach_diver_links row for this diver,
      // just in the wrong org. The widened cross-fed branch must
      // still fail closed unless link.org_id matches the diver's
      // participating home org.
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(wrongOrgCoachToken),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      expect(r.status()).toBe(403);
    });

    test("wrong role: a diver hitting the coach endpoint with someone else's id gets 403", async ({ request }) => {
      const diver2 = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Hostile Diver" });
      const { token } = await setup.loginAs(request, diver2.username);
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(token),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      // The endpoint uses verifyToken (not requireOrgRole), so the
      // gate that catches a diver is requireCoachLink, same 403 either way.
      expect(r.status()).toBe(403);
    });
  });

  // -------------------------------------------------------------
  // 3. POST /api/coach/dive-lists/:event_id/:diver_id/withdraw:
  //    irreversible, audit-logged scratch. Event must not be
  //    Completed.
  // -------------------------------------------------------------
  test.describe("POST /api/coach/.../withdraw", () => {
    let orgA, orgB;
    let event, diver, diveId, coachToken, coachUserId;
    let strangerToken, wrongOrgCoachToken;

    test.beforeAll(async ({ request }) => {
      ({ orgA, orgB } = await buildTwoOrgFixture(request));
      event = await setup.createEvent(request, {
        adminToken: orgA.adminToken,
        name: "Authz Coach Withdraw",
        total_rounds: 2,
        number_of_judges: 5,
        height: "3m",
      });
      diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
      diver = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Withdraw Diver" });
      await setup.insertDiveList({
        eventId: event.id,
        competitorId: diver.userId,
        dives: [{ round_number: 1, dive_id: diveId }, { round_number: 2, dive_id: diveId }],
      });

      const coach = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Withdraw Coach" });
      await setup.linkCoach({ coachId: coach.userId, diverId: diver.userId, orgId: orgA.orgId });
      coachUserId = coach.userId;
      ({ token: coachToken } = await setup.loginAs(request, coach.username));

      const stranger = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Stranger Coach W" });
      ({ token: strangerToken } = await setup.loginAs(request, stranger.username));

      const wrongOrg = await setup.insertUser({ orgId: orgB.orgId, role: "coach", fullName: "Wrong Org W" });
      await setup.linkCoach({ coachId: wrongOrg.userId, diverId: diver.userId, orgId: orgB.orgId });
      ({ token: wrongOrgCoachToken } = await setup.loginAs(request, wrongOrg.username));
    });

    test.afterAll(async () => {
      if (orgA) await setup.deleteOrg(orgA.orgId);
      if (orgB) await setup.deleteOrg(orgB.orgId);
    });

    test("no link: stranger gets 403 BEFORE the withdraw stamps", async ({ request }) => {
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(strangerToken), data: { reason: "should be blocked" },
      });
      expect(r.status()).toBe(403);

      // sanity check: nothing got marked.
      const check = await setup.pool.query(
        `SELECT COUNT(*)::int AS n FROM competitor_dive_lists
          WHERE event_id = $1 AND competitor_id = $2 AND withdrawn_at IS NOT NULL`,
        [event.id, diver.userId],
      );
      expect(check.rows[0].n).toBe(0);
    });

    test("wrong-org link: rejected even with a real link in Org B", async ({ request }) => {
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(wrongOrgCoachToken), data: { reason: "wrong org link" },
      });
      expect(r.status()).toBe(403);
    });

    test("host-org happy: linked coach withdraws — every row marked, audit logged", async ({ request }) => {
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(coachToken), data: { reason: "shoulder injury" },
      });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.rows_updated).toBe(2);

      const rows = await setup.pool.query(
        `SELECT withdrawn_at, withdrawn_by_user_id, withdrawn_reason
           FROM competitor_dive_lists
          WHERE event_id = $1 AND competitor_id = $2`,
        [event.id, diver.userId],
      );
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.withdrawn_at).not.toBeNull();
        expect(row.withdrawn_by_user_id).toBe(coachUserId);
        expect(row.withdrawn_reason).toBe("shoulder injury");
      }

      // Audit row written via recordAudit(). The route at commit
      // 96caa22 fixed a long-standing field-name mismatch (was
      // writing actor_user_id / context, but lib/audit.js reads
      // actor_id / metadata, so both fields were silently NULL on
      // every coach action since the feature shipped). This block
      // tightens the assertion so that fix can't regress quietly:
      // actor_id, org_id, metadata, entity_name, and note all
      // need to land.
      const audit = await setup.pool.query(
        `SELECT action, actor_id, org_id, entity_type, entity_id,
                entity_name, note, metadata
           FROM audit_log
          WHERE entity_type = 'dive_list'
            AND entity_id = $1
            AND action = 'coach.withdraw_dive_list'
          ORDER BY created_at DESC LIMIT 1`,
        [diver.userId],
      );
      const row = audit.rows[0];
      expect(row?.action).toBe("coach.withdraw_dive_list");
      expect(row?.actor_id).toBe(coachUserId);
      expect(row?.org_id).toBe(orgA.orgId);
      expect(row?.entity_type).toBe("dive_list");
      expect(row?.entity_id).toBe(diver.userId);
      // entity_name is the diver's display name, keep this lenient
      // (the route resolves it from a join, so don't pin the exact
      // shape if the helper changes).
      expect(typeof row?.entity_name).toBe("string");
      expect(row?.note).toBe("shoulder injury");
      // metadata is a jsonb column, pg returns it as a parsed object
      expect(row?.metadata).toMatchObject({
        event_id: event.id,
        coach_id: coachUserId,
        diver_id: diver.userId,
        row_count: 2,
        reason: "shoulder injury",
      });
    });

    test("already-withdrawn returns 409", async ({ request }) => {
      // Run AFTER the happy path, every row is already marked.
      const r = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(coachToken), data: { reason: "double tap" },
      });
      expect(r.status()).toBe(409);
    });
  });

  // -------------------------------------------------------------
  // 4. POST /api/coach/dive-lists/...: cross-federation coach
  //    writes. A coach linked in the diver's home org can submit
  //    and withdraw when that org is on event_participating_orgs;
  //    a link in any other org still fails closed.
  // -------------------------------------------------------------
  test.describe("coach cross-federation write boundary", () => {
    let homeOrg, hostOrg, otherOrg;
    let event, diver, diveId, homeCoachUserId;
    let homeCoachToken, wrongOrgCoachToken, noLinkCoachToken;

    test.beforeAll(async ({ request }) => {
      homeOrg = await setup.createOrgAndAdmin(request, { orgName: "Authz CrossFed Home", countryCode: "AUS" });
      hostOrg = await setup.createOrgAndAdmin(request, { orgName: "Authz CrossFed Host", countryCode: "NZL" });
      otherOrg = await setup.createOrgAndAdmin(request, { orgName: "Authz CrossFed Other", countryCode: "USA" });

      event = await setup.createEvent(request, {
        adminToken: hostOrg.adminToken,
        name: "Authz Coach CrossFed",
        total_rounds: 1,
        number_of_judges: 5,
        height: "3m",
      });
      await setup.pool.query(
        `INSERT INTO event_participating_orgs (event_id, org_id)
         VALUES ($1, $2)
         ON CONFLICT (event_id, org_id) DO NOTHING`,
        [event.id, homeOrg.orgId],
      );

      diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
      diver = await setup.insertUser({ orgId: homeOrg.orgId, role: "diver", fullName: "CrossFed Diver" });

      const homeCoach = await setup.insertUser({ orgId: homeOrg.orgId, role: "coach", fullName: "CrossFed Home Coach" });
      await setup.linkCoach({ coachId: homeCoach.userId, diverId: diver.userId, orgId: homeOrg.orgId });
      homeCoachUserId = homeCoach.userId;
      ({ token: homeCoachToken } = await setup.loginAs(request, homeCoach.username));

      const wrongOrgCoach = await setup.insertUser({ orgId: otherOrg.orgId, role: "coach", fullName: "CrossFed Wrong Org Coach" });
      await setup.linkCoach({ coachId: wrongOrgCoach.userId, diverId: diver.userId, orgId: otherOrg.orgId });
      ({ token: wrongOrgCoachToken } = await setup.loginAs(request, wrongOrgCoach.username));

      const noLinkCoach = await setup.insertUser({ orgId: homeOrg.orgId, role: "coach", fullName: "CrossFed No Link Coach" });
      ({ token: noLinkCoachToken } = await setup.loginAs(request, noLinkCoach.username));
    });

    test.afterAll(async () => {
      if (homeOrg) await setup.deleteOrg(homeOrg.orgId);
      if (hostOrg) await setup.deleteOrg(hostOrg.orgId);
      if (otherOrg) await setup.deleteOrg(otherOrg.orgId);
    });

    test("eligibility metadata marks invited writable links and unrelated read-only links", async ({ request }) => {
      const homeEvents = await request.get("/api/coach/events", {
        headers: auth(homeCoachToken),
      });
      expect(homeEvents.status()).toBe(200);
      const homeEventRow = (await homeEvents.json()).find((row) => row.event_id === event.id);
      expect(homeEventRow).toBeTruthy();
      expect(homeEventRow.coach_eligibility).toMatchObject({
        host_federation: false,
        invited_federation: true,
        can_submit: true,
        can_withdraw: false,
        read_only: false,
      });

      const homeLists = await request.get(`/api/coach/dive-lists/${event.id}`, {
        headers: auth(homeCoachToken),
      });
      expect(homeLists.status()).toBe(200);
      const homeBody = await homeLists.json();
      expect(homeBody.event.coach_eligibility).toMatchObject(homeEventRow.coach_eligibility);
      expect(homeBody.divers[0].coach_eligibility).toMatchObject(homeEventRow.coach_eligibility);

      const wrongEvents = await request.get("/api/coach/events", {
        headers: auth(wrongOrgCoachToken),
      });
      expect(wrongEvents.status()).toBe(200);
      const wrongEventRow = (await wrongEvents.json()).find((row) => row.event_id === event.id);
      expect(wrongEventRow).toBeTruthy();
      expect(wrongEventRow.coach_eligibility).toMatchObject({
        host_federation: false,
        invited_federation: false,
        can_submit: false,
        can_withdraw: false,
        read_only: true,
      });

      const wrongLists = await request.get(`/api/coach/dive-lists/${event.id}`, {
        headers: auth(wrongOrgCoachToken),
      });
      expect(wrongLists.status()).toBe(200);
      const wrongBody = await wrongLists.json();
      expect(wrongBody.event.coach_eligibility).toMatchObject(wrongEventRow.coach_eligibility);
      expect(wrongBody.divers[0].coach_eligibility).toMatchObject(wrongEventRow.coach_eligibility);
    });

    test("cross-fed coach submits under diver home org, then withdraws", async ({ request }) => {
      const submit = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(homeCoachToken),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      expect(submit.status()).toBe(200);

      // competitor_dive_lists has no org column, the entry is
      // bound by competitor_id instead. The persisted competitor
      // remains the home-org diver while the event stays hosted
      // elsewhere, matching the diver-self cross-federation entry model.
      const entry = await setup.pool.query(
        `SELECT cdl.round_number,
                cdl.withdrawn_at,
                u.org_id AS competitor_org_id,
                e.org_id AS event_org_id
           FROM competitor_dive_lists cdl
           JOIN users u ON u.id = cdl.competitor_id
           JOIN events e ON e.id = cdl.event_id
          WHERE cdl.event_id = $1 AND cdl.competitor_id = $2`,
        [event.id, diver.userId],
      );
      expect(entry.rows).toHaveLength(1);
      expect(entry.rows[0].round_number).toBe(1);
      expect(entry.rows[0].withdrawn_at).toBeNull();
      expect(entry.rows[0].competitor_org_id).toBe(homeOrg.orgId);
      expect(entry.rows[0].event_org_id).toBe(hostOrg.orgId);

      const withdraw = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(homeCoachToken),
        data: { reason: "cross-fed scratch" },
      });
      expect(withdraw.status()).toBe(200);
      expect((await withdraw.json()).rows_updated).toBe(1);

      const withdrawn = await setup.pool.query(
        `SELECT withdrawn_by_user_id, withdrawn_reason
           FROM competitor_dive_lists
          WHERE event_id = $1 AND competitor_id = $2`,
        [event.id, diver.userId],
      );
      expect(withdrawn.rows[0].withdrawn_by_user_id).toBe(homeCoachUserId);
      expect(withdrawn.rows[0].withdrawn_reason).toBe("cross-fed scratch");
    });

    test("unrelated link: non-host, non-participating org still gets 403 for submit and withdraw", async ({ request }) => {
      const submit = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(wrongOrgCoachToken),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      expect(submit.status()).toBe(403);

      const withdraw = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(wrongOrgCoachToken),
        data: { reason: "wrong org link" },
      });
      expect(withdraw.status()).toBe(403);
    });

    test("no link: coach still gets 403 for submit and withdraw", async ({ request }) => {
      const submit = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}`, {
        headers: auth(noLinkCoachToken),
        data: { dives: [{ round_number: 1, dive_id: diveId }] },
      });
      expect(submit.status()).toBe(403);

      const withdraw = await request.post(`/api/coach/dive-lists/${event.id}/${diver.userId}/withdraw`, {
        headers: auth(noLinkCoachToken),
        data: { reason: "no link" },
      });
      expect(withdraw.status()).toBe(403);
    });
  });

  // -------------------------------------------------------------
  // 5. GET /api/coach/dive-lists/:event_id: cross-fed body-field
  //    redaction. A coach with no diver actually entered AND in
  //    another federation must NOT see round_rules /
  //    prescribed_rounds / partner_name.
  // -------------------------------------------------------------
  test.describe("GET /api/coach/dive-lists/:event_id body-field redaction", () => {
    let orgA, orgB;
    let event, coachSameOrgToken, coachCrossFedToken;
    let diverA, diverB, diveId;

    test.beforeAll(async ({ request }) => {
      ({ orgA, orgB } = await buildTwoOrgFixture(request));

      // Wire Org B onto the event's participating list, without
      // that the cross-fed coach's eligible check 403s before we
      // ever get to the redaction logic.
      event = await setup.createEvent(request, {
        adminToken: orgA.adminToken,
        name: "Authz Redact",
        total_rounds: 1,
        number_of_judges: 5,
        height: "3m",
      });
      // Give the event a non-null round_rules so the redaction is
      // observable. Same with a prescribed round dive.
      diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
      await setup.pool.query(
        `UPDATE events SET round_rules = $2 WHERE id = $1`,
        [event.id, JSON.stringify({ note: "secret config" })],
      );
      await setup.pool.query(
        `INSERT INTO event_round_dives (event_id, round_number, dive_id)
         VALUES ($1, 1, $2)`,
        [event.id, diveId],
      );
      await setup.pool.query(
        `INSERT INTO event_participating_orgs (event_id, org_id) VALUES ($1, $2)`,
        [event.id, orgB.orgId],
      );

      diverA = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "DiverA" });
      diverB = await setup.insertUser({ orgId: orgB.orgId, role: "diver", fullName: "DiverB" });

      const coachSame = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Same Coach" });
      await setup.linkCoach({ coachId: coachSame.userId, diverId: diverA.userId, orgId: orgA.orgId });
      ({ token: coachSameOrgToken } = await setup.loginAs(request, coachSame.username));

      const coachCross = await setup.insertUser({ orgId: orgB.orgId, role: "coach", fullName: "Cross Coach" });
      // The cross-fed coach's link is in Org B (their home org) but
      // points at a diver in Org B. The event lives in Org A and
      // has Org B on the participating list, so the eligibility
      // check passes but the body-field gate should NOT.
      await setup.linkCoach({ coachId: coachCross.userId, diverId: diverB.userId, orgId: orgB.orgId });
      ({ token: coachCrossFedToken } = await setup.loginAs(request, coachCross.username));
    });

    test.afterAll(async () => {
      if (orgA) await setup.deleteOrg(orgA.orgId);
      if (orgB) await setup.deleteOrg(orgB.orgId);
    });

    test("same-org coach sees full body fields", async ({ request }) => {
      const r = await request.get(`/api/coach/dive-lists/${event.id}`, { headers: auth(coachSameOrgToken) });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.event.round_rules).not.toBeNull();
      expect(Array.isArray(body.event.prescribed_rounds)).toBe(true);
      expect(body.event.prescribed_rounds.length).toBeGreaterThan(0);
    });

    test("cross-fed coach with no diver actually entered: round_rules + prescribed_rounds redacted", async ({ request }) => {
      const r = await request.get(`/api/coach/dive-lists/${event.id}`, { headers: auth(coachCrossFedToken) });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.event.round_rules).toBeNull();
      expect(body.event.prescribed_rounds).toEqual([]);
    });

    test("cross-fed coach with a diver entered: redaction lifts", async ({ request }) => {
      // Once Org B's diver has a row on this event, the body
      // fields should re-appear (the coach has an actual stake in
      // this event's config now).
      await setup.insertDiveList({
        eventId: event.id,
        competitorId: diverB.userId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
      const r = await request.get(`/api/coach/dive-lists/${event.id}`, { headers: auth(coachCrossFedToken) });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.event.round_rules).not.toBeNull();
      expect(body.event.prescribed_rounds.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------
  // 6. GET /api/coach/up-next: only returns rows for coach's
  //    linked divers. A coach with NO links gets an empty rows
  //    array even when another coach's divers are live.
  // -------------------------------------------------------------
  test.describe("GET /api/coach/up-next", () => {
    let orgA;
    let event, coachWithLinksToken, unlinkedCoachToken;

    test.beforeAll(async ({ request }) => {
      orgA = await setup.createOrgAndAdmin(request, { orgName: "Authz UpNext", countryCode: "GBR" });

      event = await setup.createEvent(request, {
        adminToken: orgA.adminToken,
        name: "Authz Up Next",
        total_rounds: 2,
        number_of_judges: 5,
        height: "3m",
      });
      const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });

      // Two divers, both entered with display_order 1 and 2.
      const active = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Active Diver" });
      const nextUp = await setup.insertUser({ orgId: orgA.orgId, role: "diver", fullName: "Next Up Diver" });
      await setup.insertDiveList({
        eventId: event.id, competitorId: active.userId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
      await setup.insertDiveList({
        eventId: event.id, competitorId: nextUp.userId,
        dives: [{ round_number: 1, dive_id: diveId }],
      });
      await setup.pool.query(
        `UPDATE competitor_dive_lists SET display_order = 1
          WHERE event_id = $1 AND competitor_id = $2`,
        [event.id, active.userId],
      );
      await setup.pool.query(
        `UPDATE competitor_dive_lists SET display_order = 2
          WHERE event_id = $1 AND competitor_id = $2`,
        [event.id, nextUp.userId],
      );

      // Coach with a link to "nextUp": should see one row.
      const coachLinked = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Linked Coach" });
      await setup.linkCoach({ coachId: coachLinked.userId, diverId: nextUp.userId, orgId: orgA.orgId });
      ({ token: coachWithLinksToken } = await setup.loginAs(request, coachLinked.username));

      // Coach with NO links: should see zero rows even though
      // there's a live event with squad members in flight.
      const lonelyCoach = await setup.insertUser({ orgId: orgA.orgId, role: "coach", fullName: "Lonely Coach" });
      ({ token: unlinkedCoachToken } = await setup.loginAs(request, lonelyCoach.username));

      // Flip Live + set the active diver via SQL (bypasses the
      // socket path; same write the socket handler performs).
      await setup.setEventStatus(request, {
        adminToken: orgA.adminToken, eventId: event.id, status: "Live",
      });
      await setup.pool.query(
        `INSERT INTO event_live_state (event_id, active_diver_payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (event_id) DO UPDATE
           SET active_diver_payload = EXCLUDED.active_diver_payload,
               on_hold_reason = NULL,
               updated_at = now()`,
        [event.id, JSON.stringify({ competitor_id: active.userId, round_number: 1 })],
      );
    });

    test.afterAll(async () => { if (orgA) await setup.deleteOrg(orgA.orgId); });

    test("happy: linked coach sees their diver and ETA arithmetic is sane", async ({ request }) => {
      const r = await request.get(`/api/coach/up-next`, { headers: auth(coachWithLinksToken) });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0].full_name).toBe("Next Up Diver");
      // dives_until: same round, display_order 2 vs active 1 → 1 dive.
      // SQL returns numeric/integer as strings via pg, so we Number()
      // the values here rather than tightening the route to cast its
      // CASE arithmetic back to int (that'd change the response shape
      // for other consumers).
      expect(Number(body.rows[0].dives_until)).toBe(1);
      // Default seconds_per_dive=45 → eta_seconds = 45.
      expect(Number(body.rows[0].eta_seconds)).toBe(45);
    });

    test("no links: coach gets an empty rows array", async ({ request }) => {
      const r = await request.get(`/api/coach/up-next`, { headers: auth(unlinkedCoachToken) });
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(body.rows).toEqual([]);
    });

    test("anonymous: 403", async ({ request }) => {
      const r = await request.get(`/api/coach/up-next`);
      expect(r.status()).toBe(403);
    });
  });
});
