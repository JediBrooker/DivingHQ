#!/usr/bin/env node
// DivingHQ to Daktronics venue bridge.
//
// Subscribes to the existing `venue.scoreboard_state` stream and writes
// Daktronics-friendly RTD frames out to UDP/TCP/stdout/file/serial.
// Meant to run on the operator's laptop, inside the venue LAN.

const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const { execFileSync } = require("node:child_process");
const { io } = require("socket.io-client");
const {
  buildFixedLayout,
  formatFrame,
  rtdPortForSource,
} = require("../lib/daktronics-bridge");

function usage() {
  const layout = buildFixedLayout();
  const frameLength = layout.reduce((sum, field) => sum + field.width, 0);
  return `
DivingHQ Daktronics bridge

Usage:
  node scripts/venue-daktronics-bridge.js --event-id <uuid> [options]

Required:
  --event-id <uuid>           Event to mirror to the venue board.

Source:
  --app-url <url>             DivingHQ base URL. Default: DIVINGHQ_URL or http://127.0.0.1:3000
  --once                      Fetch one HTTP snapshot, write it, and exit.

Output:
  --transport <name>          stdout | udp | tcp | file | serial. Default: stdout
  --format <name>             rtd | json. Default: rtd
  --host <host>               UDP/TCP destination host. Default: 127.0.0.1
  --port <port>               UDP/TCP destination port. Default: derived from --data-source
  --data-source <n>           Daktronics ERTD source value. Port = 21000 + n*10. Default: 0
  --broadcast                 Enable UDP broadcast.
  --path <path>               File or serial device path.
  --baud <rate>               Serial baud rate. Default: 19200
  --newline <name>            crlf | lf | none. Default: crlf
  --repeat-ms <n>             Re-send latest frame periodically. Default: 1000; 0 disables.
  --max-judges <n>            Fixed RTD score slots. Default: 11
  --top-n <n>                 Leaderboard rows in the frame. Default: 8
  --quiet                     Suppress status logs.

Examples:
  # Safe dry run: print fixed-width RTD frames.
  node scripts/venue-daktronics-bridge.js --event-id EVENT_ID

  # All Sport Pro / ERTD network feed, source 4 = UDP 21040.
  node scripts/venue-daktronics-bridge.js --event-id EVENT_ID \\
    --transport udp --host 192.168.0.255 --broadcast --data-source 4

  # Data Studio-style JSON frames over TCP.
  node scripts/venue-daktronics-bridge.js --event-id EVENT_ID \\
    --transport tcp --host 192.168.1.50 --port 21000 --format json

Fixed RTD layout:
${layout.map((f) => `  ${String(f.item).padStart(2, " ")} ${f.key.padEnd(24)} ${String(f.width).padStart(3, " ")} chars`).join("\n")}

Fixed RTD payload length: ${frameLength} chars before newline.
`;
}

function parseArgs(argv, env = process.env) {
  const args = {
    appUrl: env.DIVINGHQ_URL || "http://127.0.0.1:3000",
    eventId: env.DIVINGHQ_EVENT_ID || "",
    transport: env.DAKTRONICS_TRANSPORT || "stdout",
    format: env.DAKTRONICS_FORMAT || "rtd",
    host: env.DAKTRONICS_HOST || "127.0.0.1",
    port: env.DAKTRONICS_PORT ? Number(env.DAKTRONICS_PORT) : null,
    dataSource: env.DAKTRONICS_DATA_SOURCE != null
      ? Number(env.DAKTRONICS_DATA_SOURCE)
      : 0,
    broadcast: env.DAKTRONICS_BROADCAST === "1",
    path: env.DAKTRONICS_PATH || "",
    baud: env.DAKTRONICS_BAUD ? Number(env.DAKTRONICS_BAUD) : 19200,
    newline: env.DAKTRONICS_NEWLINE || "crlf",
    repeatMs: env.DAKTRONICS_REPEAT_MS != null
      ? Number(env.DAKTRONICS_REPEAT_MS)
      : 1000,
    maxJudges: env.DAKTRONICS_MAX_JUDGES
      ? Number(env.DAKTRONICS_MAX_JUDGES)
      : 11,
    topN: env.DAKTRONICS_TOP_N ? Number(env.DAKTRONICS_TOP_N) : 8,
    once: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[++i];
    };
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--app-url") {
      args.appUrl = next();
    } else if (arg === "--event-id") {
      args.eventId = next();
    } else if (arg === "--transport") {
      args.transport = next();
    } else if (arg === "--format") {
      args.format = next();
    } else if (arg === "--host") {
      args.host = next();
    } else if (arg === "--port") {
      args.port = Number(next());
    } else if (arg === "--data-source") {
      args.dataSource = Number(next());
    } else if (arg === "--broadcast") {
      args.broadcast = true;
    } else if (arg === "--path") {
      args.path = next();
    } else if (arg === "--baud") {
      args.baud = Number(next());
    } else if (arg === "--newline") {
      args.newline = next();
    } else if (arg === "--repeat-ms") {
      args.repeatMs = Number(next());
    } else if (arg === "--max-judges") {
      args.maxJudges = Number(next());
    } else if (arg === "--top-n") {
      args.topN = Number(next());
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (args.help) return args;
  if (!args.eventId) throw new Error("--event-id is required");
  if (!["stdout", "udp", "tcp", "file", "serial"].includes(args.transport)) {
    throw new Error("--transport must be stdout, udp, tcp, file, or serial");
  }
  if (!["rtd", "fixed", "json"].includes(args.format)) {
    throw new Error("--format must be rtd or json");
  }
  if (!Number.isInteger(args.repeatMs) || args.repeatMs < 0) {
    throw new Error("--repeat-ms must be a non-negative integer");
  }
  if (!Number.isInteger(args.maxJudges) || args.maxJudges < 1 || args.maxJudges > 25) {
    throw new Error("--max-judges must be an integer from 1 to 25");
  }
  if (!Number.isInteger(args.topN) || args.topN < 0 || args.topN > 20) {
    throw new Error("--top-n must be an integer from 0 to 20");
  }
  if (args.transport === "file" && !args.path) {
    throw new Error("--path is required for --transport file");
  }
  if (args.transport === "serial" && !args.path) {
    throw new Error("--path is required for --transport serial");
  }
  if (args.port == null) args.port = rtdPortForSource(args.dataSource);
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if (!Number.isInteger(args.baud) || args.baud < 300) {
    throw new Error("--baud must be a valid serial rate");
  }

  return args;
}

function log(args, ...parts) {
  if (!args.quiet) console.error("[daktronics-bridge]", ...parts);
}

function configureSerial(path, baud) {
  const command = process.platform === "darwin" ? "stty" : "stty";
  const flag = process.platform === "darwin" ? "-f" : "-F";
  try {
    execFileSync(command, [flag, path, String(baud), "cs8", "-parenb", "-cstopb", "-ixon", "-ixoff"], {
      stdio: "ignore",
    });
  } catch (err) {
    throw new Error(`Failed to configure serial device ${path}: ${err.message}`);
  }
}

function createSink(args) {
  if (args.transport === "stdout") {
    return {
      send(buffer) {
        process.stdout.write(buffer);
      },
      close() {},
    };
  }

  if (args.transport === "udp") {
    const socket = dgram.createSocket("udp4");
    socket.on("listening", () => {
      if (args.broadcast) socket.setBroadcast(true);
    });
    socket.bind();
    return {
      send(buffer) {
        socket.send(buffer, args.port, args.host);
      },
      close() {
        socket.close();
      },
    };
  }

  if (args.transport === "tcp") {
    let socket = null;
    let connected = false;
    let retry = null;
    const pending = [];
    const connect = () => {
      socket = net.createConnection({ host: args.host, port: args.port });
      socket.on("connect", () => {
        connected = true;
        log(args, `connected to tcp://${args.host}:${args.port}`);
        while (pending.length) socket.write(pending.shift());
      });
      socket.on("error", (err) => {
        connected = false;
        log(args, `TCP error: ${err.message}`);
      });
      socket.on("close", () => {
        connected = false;
        if (!retry) {
          retry = setTimeout(() => {
            retry = null;
            connect();
          }, 1000);
        }
      });
    };
    connect();
    return {
      send(buffer) {
        if (connected) socket.write(buffer);
        else pending.push(Buffer.from(buffer));
      },
      close() {
        if (retry) clearTimeout(retry);
        if (socket) socket.destroy();
      },
    };
  }

  if (args.transport === "serial") {
    configureSerial(args.path, args.baud);
  }

  const stream = fs.createWriteStream(args.path, {
    flags: args.transport === "serial" ? "w" : "a",
  });
  return {
    send(buffer) {
      stream.write(buffer);
    },
    close() {
      stream.end();
    },
  };
}

async function fetchSnapshot(args) {
  const url = new URL(`/api/venue/scoreboard-state/${encodeURIComponent(args.eventId)}`, args.appUrl);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP snapshot failed: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

function stateToFrame(state, args) {
  return formatFrame(state, {
    format: args.format,
    newline: args.newline,
    maxJudges: args.maxJudges,
    topN: args.topN,
  });
}

async function run(args) {
  const sink = createSink(args);
  let latest = null;
  let repeatTimer = null;
  const send = (state, reason) => {
    latest = state;
    sink.send(stateToFrame(state, args));
    log(args, `${reason}: seq=${state.sequence || "?"} event=${state.event_id || "?"}`);
  };

  try {
    const initial = await fetchSnapshot(args);
    send(initial, "snapshot");

    if (args.once) {
      sink.close();
      return;
    }

    if (args.repeatMs > 0) {
      repeatTimer = setInterval(() => {
        if (latest) sink.send(stateToFrame(latest, args));
      }, args.repeatMs);
    }

    const socket = io(args.appUrl, {
      transports: ["websocket"],
      reconnection: true,
    });
    socket.on("connect", () => {
      log(args, `connected to ${args.appUrl}; subscribing to venue ${args.eventId}`);
      socket.emit("subscribe_venue", { event_id: args.eventId });
    });
    socket.on("connect_error", (err) => {
      log(args, `socket connect error: ${err.message}`);
    });
    socket.on("venue.scoreboard_state", (state) => {
      if (state?.event_id === args.eventId) send(state, "socket");
    });

    const shutdown = () => {
      if (repeatTimer) clearInterval(repeatTimer);
      socket.close();
      sink.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (err) {
    if (repeatTimer) clearInterval(repeatTimer);
    sink.close();
    throw err;
  }
}

if (require.main === module) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      if (args.help) {
        process.stdout.write(usage());
        return;
      }
      await run(args);
    } catch (err) {
      console.error(`[daktronics-bridge] ${err.message}`);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  createSink,
  fetchSnapshot,
  parseArgs,
  run,
  stateToFrame,
  usage,
};
