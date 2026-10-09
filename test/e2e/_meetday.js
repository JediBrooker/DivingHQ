// Fixtures shared by the meet-day regression specs (Control Room, judge
// screen, spectator scoreboard). Not a spec itself: the leading
// underscore keeps it out of Playwright's testMatch, same as _setup.js.
//
// Every spec here used to carry its own copy of signIn + liveEvent, and
// they'd drifted a little (rounds, panel size). One copy now.
const setup = require("./_setup");

async function signIn(page, username) {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });
}

// An event with a panel, a handful of divers and one dive per round each.
// Judges come back with a live token so specs can score over the socket.
async function liveEvent(request, {
  orgId, adminToken, name, diverNames,
  rounds = 1, judges: panel = 5, eventType = "individual",
  status = "Live", extra = {},
}) {
  const event = await setup.createEvent(request, {
    adminToken, name, total_rounds: rounds, number_of_judges: panel,
    height: "3m", event_type: eventType, ...extra,
  });
  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const divers = [];
  for (const dn of diverNames) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: dn });
    const dives = [];
    for (let r = 1; r <= rounds; r++) dives.push({ round_number: r, dive_id: diveId });
    await setup.insertDiveList({ eventId: event.id, competitorId: d.userId, dives });
    divers.push(d);
  }
  const judges = [];
  for (let i = 1; i <= panel; i++) {
    const j = await setup.insertUser({ orgId, role: "judge", fullName: `${name} J${i}` });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, { adminToken, eventId: event.id, judgeIds: judges.map((j) => j.userId) });
  if (status === "Live") await setup.setEventStatus(request, { adminToken, eventId: event.id, status: "Live" });
  return { event, diveId, divers, judges };
}

// A socket parked in the event room that records what the room hears,
// so a spec can assert on the wire instead of guessing from the UI.
async function roomWatcher(baseURL, eventId, token = "spectator") {
  const sock = await setup.openSocket(baseURL, token);
  const seen = {
    state: [], announced: [], held: [], resumed: [], redive: [], corrected: [],
  };
  const mine = (d) => d && d.event_id === eventId;
  sock.on("state_update", (d) => { if (mine(d)) seen.state.push(d); });
  sock.on("final_score_announced", (d) => { if (mine(d)) seen.announced.push(d); });
  sock.on("meet_held", (d) => { if (mine(d)) seen.held.push(d); });
  sock.on("meet_resumed", (d) => { if (mine(d)) seen.resumed.push(d); });
  sock.on("referee_action_redive", (d) => { if (mine(d)) seen.redive.push(d); });
  sock.on("score_corrected", (d) => { if (mine(d)) seen.corrected.push(d); });
  sock.emit("subscribe_event", { event_id: eventId });
  return { sock, seen, close: () => sock.disconnect() };
}

// Every WebSocket the page opens lands in window.__sockets, so a test can
// drop them the way a phone losing signal does. Going offline in the
// browser doesn't close one that's already open. Call before the page loads.
async function trackSockets(page) {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        window.__sockets.push(this);
      }
    };
  });
}

// Fire a privileged socket action as someone (an admin token, say) and
// wait for the server's ack.
async function emitAck(baseURL, token, eventName, payload) {
  const sock = await setup.openSocket(baseURL, token);
  try {
    if (eventName === "set_active_diver") {
      const claim = await new Promise(resolve => sock.emit("claim_event_control", { event_id: payload.event_id, protocol: 2 }, resolve));
      if (!claim?.ok) return claim;
      payload = { ...payload, control_token: claim.control_token };
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: "ack timeout" }), 5000);
      sock.emit(eventName, payload, (res) => { clearTimeout(timer); resolve(res); });
    });
  } finally {
    sock.disconnect();
  }
}

module.exports = { signIn, liveEvent, roomWatcher, emitAck, trackSockets };
