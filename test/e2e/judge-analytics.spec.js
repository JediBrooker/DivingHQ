// Judge Analysis (WA judging-programme metrics): analytics
// endpoint coverage. Seeds a controlled meet where we know
// exactly what each judge scored relative to the kept-mean panel
// and asserts the API returns the deviations + drop counts the
// math says it should.
//
// World Aquatics references (PART FOUR of the Competition Regulations):
//   * 7.9   - Awards and scoring of dives by Judges
//   * 8.4.9 - Referee may remove a Judge whose judgement is
//             unsatisfactory; report to Jury of Appeal. The
//             evidence trail this endpoint exposes is the same
//             signal an WA assessor would compute by hand.
//   * 13    - Trim rules (drop top + bottom k) + dive-points formula.
//
// What this test seeds
// --------------------
//   * 5-judge panel (drop_count = 1; kept set = middle 3)
//   * 1 diver, 1 dive (101B @ 3m, DD 1.6, group 1 = forward)
//   * Judge scores: J1=8.5, J2=8.0, J3=7.5, J4=7.0, J5=9.5
//
//   Sorted ascending: [7.0, 7.5, 8.0, 8.5, 9.5]
//   Trim drops 1 low (7.0) + 1 high (9.5).
//   Kept-mean = (7.5 + 8.0 + 8.5) / 3 = 8.0
//
//   Expected per-judge deviation vs the kept-mean of 8.0:
//     J1 (8.5):  +0.5    NOT dropped       (kept high end of the slice)
//     J2 (8.0):   0.0    NOT dropped       (kept median)
//     J3 (7.5): -0.5     NOT dropped       (kept low end of the slice)
//     J4 (7.0): -1.0     DROPPED low
//     J5 (9.5): +1.5     DROPPED high

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("judge-analytics: deviation + drop math matches WA trim semantics", async ({
  request,
}) => {
  test.setTimeout(60_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // 5-judge panel + 1 diver + 1 dive, small enough to assert on.
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Judge Analytics",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
  });

  // Need a club + country on the diver so the country / club
  // breakdown widgets have something to bucket against. Country
  // comes off the org (set by createOrgAndAdmin to "TST").
  const { clubId } = await setup.insertClub({
    orgId, name: "Analytics Club", shortCode: "ANC",
  });
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Analytics Diver", clubId,
  });

  // 5 judges, assigned in order so judge_number = position + 1.
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    judges.push(
      await setup.insertUser({
        orgId, role: "judge", fullName: `Analytics Judge ${i}`,
      }),
    );
  }

  // 101B @ 3m → forward 1.5 somers pike.
  const dive101B = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });

  // Wire up panel + dive list + scores.
  for (let i = 0; i < judges.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [event.id, judges[i].userId, i + 1],
    );
  }
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: dive101B }],
  });

  // Scores: J1=8.5, J2=8.0, J3=7.5, J4=7.0, J5=9.5
  const seeded = [8.5, 8.0, 7.5, 7.0, 9.5];
  for (let i = 0; i < judges.length; i++) {
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [event.id, diver.userId, judges[i].userId, dive101B, seeded[i]],
    );
  }

  // ---- Log in as J1 (the keeper of the high end of the kept slice).
  const j1Login = await setup.loginAs(request, judges[0].username);
  const j1Token = j1Login.token;

  // ---- /profile: header stats roll up across J1's single dive
  const j1Profile = await request.get(
    `/api/judges/${judges[0].userId}/profile`,
    { headers: { Authorization: `Bearer ${j1Token}` } },
  );
  expect(j1Profile.status()).toBe(200);
  const j1ProfileBody = await j1Profile.json();
  expect(j1ProfileBody.judge.full_name).toBe("Analytics Judge 1");
  expect(j1ProfileBody.stats.events_officiated).toBe(1);
  expect(j1ProfileBody.stats.total_scores).toBe(1);
  expect(j1ProfileBody.stats.comparable_scores).toBe(1);
  // J1 = 8.5, kept-mean = 8.0 → +0.5
  expect(Number(j1ProfileBody.stats.mean_signed_deviation)).toBeCloseTo(0.5, 3);
  expect(Number(j1ProfileBody.stats.mean_abs_deviation)).toBeCloseTo(0.5, 3);
  // J1 not dropped → drop_rate = 0
  expect(Number(j1ProfileBody.stats.drop_rate)).toBe(0);

  // ---- /analytics: per-widget rollups
  const j1Analytics = await request.get(
    `/api/judges/${judges[0].userId}/analytics`,
    { headers: { Authorization: `Bearer ${j1Token}` } },
  );
  expect(j1Analytics.status()).toBe(200);
  const j1A = await j1Analytics.json();

  // bias_summary
  expect(j1A.bias_summary.sample_size).toBe(1);
  expect(Number(j1A.bias_summary.mean_signed_deviation)).toBeCloseTo(0.5, 3);

  // agreement_rate: J1 is within ±0.5 of kept-mean (exactly 0.5 → counted).
  expect(j1A.agreement_rate.total).toBe(1);
  expect(j1A.agreement_rate.within_half).toBe(1);
  expect(Number(j1A.agreement_rate.within_half_rate)).toBe(1);

  // drop_rate: J1 not dropped.
  expect(j1A.drop_rate.sample_size).toBe(1);
  expect(j1A.drop_rate.dropped).toBe(0);
  expect(j1A.drop_rate.dropped_high).toBe(0);
  expect(j1A.drop_rate.dropped_low).toBe(0);

  // height_breakdown: single 3m bucket
  expect(j1A.height_breakdown.length).toBe(1);
  expect(Number(j1A.height_breakdown[0].height)).toBe(3.0);
  expect(j1A.height_breakdown[0].dives).toBe(1);
  expect(Number(j1A.height_breakdown[0].signed_deviation)).toBeCloseTo(0.5, 3);

  // group_breakdown: '1' (forward)
  expect(j1A.group_breakdown.length).toBe(1);
  expect(j1A.group_breakdown[0].dive_group).toBe("1");

  // round_breakdown: single round 1
  expect(j1A.round_breakdown.length).toBe(1);
  expect(j1A.round_breakdown[0].round_number).toBe(1);

  // panel_compare: my_avg = 8.5, panel_avg = 8.0
  expect(j1A.panel_compare.dives).toBe(1);
  expect(Number(j1A.panel_compare.my_avg)).toBeCloseTo(8.5, 2);
  expect(Number(j1A.panel_compare.panel_avg)).toBeCloseTo(8.0, 2);

  // recent_meets: 1 row with this event
  expect(j1A.recent_meets.length).toBe(1);
  expect(j1A.recent_meets[0].event_id).toBe(event.id);
  expect(j1A.recent_meets[0].dives).toBe(1);
  expect(Number(j1A.recent_meets[0].signed_deviation)).toBeCloseTo(0.5, 3);

  // ---- Now log in as J5 (the dropped HIGH).
  const j5Login = await setup.loginAs(request, judges[4].username);
  const j5Token = j5Login.token;
  const j5Profile = await request.get(
    `/api/judges/${judges[4].userId}/profile`,
    { headers: { Authorization: `Bearer ${j5Token}` } },
  );
  expect(j5Profile.status()).toBe(200);
  const j5P = await j5Profile.json();
  // J5 = 9.5, kept-mean = 8.0 → +1.5
  expect(Number(j5P.stats.mean_signed_deviation)).toBeCloseTo(1.5, 3);
  expect(Number(j5P.stats.mean_abs_deviation)).toBeCloseTo(1.5, 3);
  // Dropped HIGH → drop_rate 1.0, drop_high_rate 1.0, drop_low_rate 0
  expect(Number(j5P.stats.drop_rate)).toBe(1);
  expect(Number(j5P.stats.drop_high_rate)).toBe(1);
  expect(Number(j5P.stats.drop_low_rate)).toBe(0);

  // ---- And J4 (the dropped LOW).
  const j4Login = await setup.loginAs(request, judges[3].username);
  const j4Token = j4Login.token;
  const j4Profile = await request.get(
    `/api/judges/${judges[3].userId}/profile`,
    { headers: { Authorization: `Bearer ${j4Token}` } },
  );
  expect(j4Profile.status()).toBe(200);
  const j4P = await j4Profile.json();
  // J4 = 7.0, kept-mean = 8.0 → -1.0
  expect(Number(j4P.stats.mean_signed_deviation)).toBeCloseTo(-1.0, 3);
  expect(Number(j4P.stats.mean_abs_deviation)).toBeCloseTo(1.0, 3);
  // Dropped LOW → drop_rate 1.0, drop_low_rate 1.0, drop_high_rate 0
  expect(Number(j4P.stats.drop_rate)).toBe(1);
  expect(Number(j4P.stats.drop_low_rate)).toBe(1);
  expect(Number(j4P.stats.drop_high_rate)).toBe(0);

  // ---- Public read: judge profiles are public (transparency).
  // A different org's judge can read J1's analytics, AND a
  // genuinely anonymous viewer (no Authorization header) can too.
  // What's redacted from public viewers: `dashboard_widgets`
  // (UI preference), that field stays owner / same-org only.
  const otherOrg = await setup.createOrgAndAdmin(request);
  const otherJudge = await setup.insertUser({
    orgId: otherOrg.orgId, role: "judge", fullName: "Other Org Judge",
  });
  const otherLogin = await setup.loginAs(request, otherJudge.username);
  const cross = await request.get(
    `/api/judges/${judges[0].userId}/profile`,
    { headers: { Authorization: `Bearer ${otherLogin.token}` } },
  );
  expect(cross.status()).toBe(200);
  const crossBody = await cross.json();
  expect(crossBody.judge.full_name).toBe("Analytics Judge 1");
  // Cross-org viewer is NOT owner / same-org admin → no UI prefs.
  expect(crossBody.dashboard_widgets).toBeUndefined();
  // The deviation rollups are still there.
  expect(Number(crossBody.stats.mean_signed_deviation)).toBeCloseTo(0.5, 3);

  // Anonymous viewer (no token): the same redaction rules apply.
  const anon = await request.get(
    `/api/judges/${judges[0].userId}/profile`,
  );
  expect(anon.status()).toBe(200);
  const anonBody = await anon.json();
  expect(anonBody.judge.full_name).toBe("Analytics Judge 1");
  expect(anonBody.dashboard_widgets).toBeUndefined();

  // Anonymous /analytics also resolves cleanly.
  const anonAnalytics = await request.get(
    `/api/judges/${judges[0].userId}/analytics`,
  );
  expect(anonAnalytics.status()).toBe(200);

  // Public directory: anonymous viewer can browse + search.
  const dir = await request.get(`/api/judges/directory?q=Analytics+Judge+1`);
  expect(dir.status()).toBe(200);
  const dirBody = await dir.json();
  expect(dirBody.rows.length).toBeGreaterThanOrEqual(1);
  const j1Row = dirBody.rows.find(r => r.id === judges[0].userId);
  expect(j1Row).toBeTruthy();
  // total_scores comes back as the count of scores submitted.
  expect(j1Row.total_scores).toBe(1);

  // Public typeahead.
  const search = await request.get(`/api/judges/search?q=Analytics`);
  expect(search.status()).toBe(200);
  const searchBody = await search.json();
  expect(Array.isArray(searchBody)).toBe(true);
  expect(searchBody.length).toBeGreaterThanOrEqual(1);

  // Anonymous viewers still cannot mutate the layout (verifyToken
  // returns 403 "No token provided", that's the existing API
  // behaviour shared with every other write endpoint).
  const anonPut = await request.put(`/api/users/me/judge-dashboard`, {
    data: { widgets: ["bias_summary"] },
  });
  expect(anonPut.status()).toBe(403);

  // ---- PUT widget layout: should drop unknown ids and dedupe.
  const layoutRes = await request.put(
    `/api/users/me/judge-dashboard`,
    {
      headers: { Authorization: `Bearer ${j1Token}` },
      data: {
        widgets: [
          "bias_summary",
          "deviation_distribution",
          "bias_summary",         // duplicate, should be dropped
          "not_a_real_widget",    // unknown, should be dropped
          "drop_rate",
        ],
      },
    },
  );
  expect(layoutRes.status()).toBe(200);
  const layoutBody = await layoutRes.json();
  expect(layoutBody.widgets).toEqual(
    ["bias_summary", "deviation_distribution", "drop_rate"],
  );

  // ---- And the layout round-trips through GET /profile
  const j1ProfileAfter = await request.get(
    `/api/judges/${judges[0].userId}/profile`,
    { headers: { Authorization: `Bearer ${j1Token}` } },
  );
  const j1PAfter = await j1ProfileAfter.json();
  expect(j1PAfter.dashboard_widgets).toEqual(
    ["bias_summary", "deviation_distribution", "drop_rate"],
  );

  // Cleanup
  await setup.deleteOrg(orgId);
  await setup.deleteOrg(otherOrg.orgId);
});
