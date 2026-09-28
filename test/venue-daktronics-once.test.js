// scripts/venue-daktronics-bridge.js --once: "fetch one HTTP snapshot,
// write it, and exit", the check a venue tech runs before a meet. Over
// UDP it used to close the socket before the datagram left (the tool
// said it worked, the board got nothing); over TCP the close scheduled a
// reconnect, so the command never exited.
//
// A stub app server hands out one snapshot; a local UDP or TCP listener
// plays the board.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const dgram = require("node:dgram");
const path = require("node:path");
const { spawn } = require("node:child_process");

const EVENT_ID = "11111111-2222-4333-8444-555555555555";
const STATE = {
  schema_version: 1, sequence: 7, event_id: EVENT_ID,
  event: { id: EVENT_ID, name: "Board Check 3m", height: 3, event_type: "individual", status: "Live", round: 1, total_rounds: 5 },
  active_diver: { name: "Test Diver", country_code: "AUS" },
  active_dive: { code: "105B", position: "B", dd: 2.4 },
  scores: [7, 7, 7, 7, 7], running_total: 50, current_rank: 1, field_size: 3, leaderboard: [],
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function appStub() {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(STATE));
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function runBridge(args, ms = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "venue-daktronics-bridge.js"), ...args, "--quiet"], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Date.now() - started, stderr });
    });
  });
}

test("--once over UDP delivers the frame before exiting", async () => {
  const app = await appStub();
  const board = dgram.createSocket("udp4");
  let bytes = 0;
  board.on("message", (msg) => { bytes += msg.length; });
  await new Promise((r) => board.bind(0, "127.0.0.1", r));
  try {
    const out = await runBridge(["--event-id", EVENT_ID, "--app-url", app.url, "--once",
      "--transport", "udp", "--host", "127.0.0.1", "--port", String(board.address().port)]);
    assert.equal(out.code, 0, out.stderr);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(bytes > 0, "the board received the frame");
  } finally {
    board.close();
    await app.close();
  }
});

test("--once over TCP delivers the frame and exits", async () => {
  const app = await appStub();
  let bytes = 0;
  const board = net.createServer((sock) => sock.on("data", (d) => { bytes += d.length; }));
  const port = await listen(board);
  try {
    const out = await runBridge(["--event-id", EVENT_ID, "--app-url", app.url, "--once",
      "--transport", "tcp", "--host", "127.0.0.1", "--port", String(port)]);
    assert.equal(out.signal, null, `killed after ${out.ms}ms, never exited`);
    assert.equal(out.code, 0, out.stderr);
    assert.ok(bytes > 0, "the board received the frame");
  } finally {
    await new Promise((r) => board.close(r));
    await app.close();
  }
});

test("--once over TCP with no board listening fails instead of hanging", async () => {
  const app = await appStub();
  // A port nothing listens on: grab one, then let it go.
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  try {
    const out = await runBridge(["--event-id", EVENT_ID, "--app-url", app.url, "--once",
      "--transport", "tcp", "--host", "127.0.0.1", "--port", String(port)], 15000);
    assert.equal(out.signal, null, "never exited");
    assert.equal(out.code, 1);
    assert.match(out.stderr, /not delivered/);
  } finally {
    await app.close();
  }
});
