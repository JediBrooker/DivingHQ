# Venue Integration

DivingHQ emits a canonical, vendor-agnostic **scoreboard state** event that a local bridge service translates into whatever hardware your venue uses — Daktronics LED boards, Colorado Time Systems, OmegaTiming, ALGE Timy, or a custom NDI/HDMI feed. The DivingHQ server stays out of the fixed-digit protocol business; the bridge runs on a laptop inside the venue's LAN and speaks the venue protocol locally.

DivingHQ now ships a reference **Daktronics RTD / ERTD bridge**. It consumes the existing `venue.scoreboard_state` payload and writes fixed-width RTD or JSON frames to UDP, TCP, stdout, a file, or a serial device.

## Who does what?

| Person | Responsibility |
|---|---|
| Meet operator | Opens Control Room, chooses **Broadcast → Venue hardware**, and gives the command to the venue technician |
| Venue technician | Runs the bridge laptop on the venue network and confirms the board receives frames |
| System administrator | Installs dependencies, checks firewall/network access, and provides the app URL |

Run the one-shot **Test output** command before connecting to the real board. It proves the event is publishing venue state without sending anything to hardware.

## Enable from the Control Room

For meet operators, the bridge setup lives in the same place as the projector and OBS tools:

1. Open the event in **Control Room**.
2. Click the header **...** menu.
3. Click **Broadcast**.
4. Choose **Venue hardware — Daktronics bridge...**.
5. Copy the **Test output** command first. It prints one RTD frame in Terminal and proves the selected event is publishing venue state.
6. Copy the **All Sport Pro / ERTD UDP** command when the test works. Give that command to the venue technician running the bridge laptop.

![The Control Room's venue bridge panel, listing the copyable test-output and UDP bridge commands with the event id already filled in](/guide-screenshots/control-room-venue-bridge.png)

The Control Room panel fills in the current event id and app URL for you. The venue technician only needs to adjust:

- `--host` — the Daktronics ingest address or subnet broadcast address.
- `--data-source` — the All Sport Pro / ERTD source. Source `0` sends to UDP `21000`; source `4` sends to UDP `21040`.
- `--format json` — only when the venue's Data Studio workflow expects JSON fields instead of fixed-width RTD.

Expected result: the bridge prints or sends a fresh frame whenever the active diver changes, a score lands, the meet is held/resumed, or the leaderboard changes.

## Daktronics bridge quick commands

Run from the DivingHQ project folder on the bridge laptop after `npm install`.

Safe dry run:

```bash
npm run venue:daktronics -- \
  --app-url https://your-divinghq-host.example \
  --event-id <event_uuid> \
  --once
```

All Sport Pro / ERTD UDP feed:

```bash
npm run venue:daktronics -- \
  --app-url https://your-divinghq-host.example \
  --event-id <event_uuid> \
  --transport udp \
  --host 192.168.0.255 \
  --broadcast \
  --data-source 4
```

Data Studio-style JSON over TCP:

```bash
npm run venue:daktronics -- \
  --app-url https://your-divinghq-host.example \
  --event-id <event_uuid> \
  --transport tcp \
  --host 192.168.1.50 \
  --port 21000 \
  --format json
```

Classic serial RTD:

```bash
npm run venue:daktronics -- \
  --app-url https://your-divinghq-host.example \
  --event-id <event_uuid> \
  --transport serial \
  --path /dev/tty.usbserial-0001 \
  --baud 19200
```

Use `npm run venue:daktronics -- --help` to print the complete fixed-width field layout.

## Architecture

```
   DivingHQ server (cloud)
            │
            │  Socket.IO over WSS  (or HTTP polling)
            │  Event: venue.scoreboard_state
            ▼
   venue bridge service          ◄─── runs on a venue laptop
            │
            │  Vendor-specific protocol
            │  (Daktronics RTD, CTS-5, OSM7, …)
            ▼
   venue scoreboard controller
            │
            ▼
   LED board / video wall
```

### Why a local bridge?

- **Daktronics, Colorado Time Systems, etc. speak serial protocols.** RS-232/485 doesn't traverse the internet. The bridge has to be on the venue LAN.
- **DivingHQ stays vendor-neutral.** We emit one well-documented JSON shape; federations write their own bridge for any hardware not yet supported. No need to update the central app every time a venue adopts new gear.
- **Failure isolation.** A misbehaving bridge can't affect the rest of the meet — at worst the LED board stops updating, while judging, scoring, and the spectator scoreboard continue.

## The `venue.scoreboard_state` payload

Same shape, two transports — pick whichever your bridge prefers.

### Transport 1: Socket.IO (recommended)

The bridge connects to DivingHQ's Socket.IO endpoint and joins `venue:<event_id>` rooms:

```js
socket.emit('subscribe_venue', { event_id: 'evt-uuid' })

socket.on('venue.scoreboard_state', (state) => {
  // … translate `state` into vendor packets …
})
```

The server emits a **fresh snapshot immediately on subscribe**, then re-emits whenever:

- The active diver changes (`set_active_diver`)
- A judge submits a score (`submit_score`)
- A dive is officially announced (`announce_score`)
- The meet is held or resumed (`meet_hold` / `meet_resume`)

Bridges should treat each emit as the **complete current state** — no diffing required. If a bridge sees the `sequence` field decrease (server restart), it should re-sync from scratch.

### Transport 2: HTTP polling

For hardware that can only do HTTP (some older Daktronics controllers, some custom boards):

```
GET /api/venue/scoreboard-state/<event_id>
```

Returns the same JSON payload as the socket event. Poll on whatever cadence your hardware can handle — 1–2 seconds is plenty.

## Payload shape (schema_version: 1)

```json
{
  "schema_version": 1,
  "sequence": 42,
  "emitted_at": "2026-05-17T13:42:31Z",
  "event_id": "uuid",
  "event": {
    "id": "uuid",
    "name": "Women's 3m Springboard",
    "height": 3,
    "event_type": "individual",
    "status": "Live",
    "round": 4,
    "total_rounds": 6,
    "on_hold": false,
    "on_hold_reason": null
  },
  "active_diver": {
    "competitor_id": "uuid",
    "name": "Tom Daley",
    "partner_name": null,
    "country_code": "GBR",
    "club_code": "PLY",
    "lane": null,
    "display_order": 5
  },
  "active_dive": {
    "code": "109C",
    "position": "",
    "dd": 3.5,
    "description": "Forward 4 1/2 Somersault Tuck"
  },
  "scores": [8.5, 8.0, 9.0, 8.5, 8.0],
  "dive_total": 89.25,
  "running_total": 312.50,
  "current_rank": 1,
  "field_size": 14,
  "leaderboard": [
    { "rank": 1, "name": "Tom Daley",      "country_code": "GBR", "total": 312.50 },
    { "rank": 2, "name": "Daniel Goodfellow", "country_code": "GBR", "total": 298.75 },
    { "rank": 3, "name": "Sho Sakai",      "country_code": "JPN", "total": 294.50 }
  ]
}
```

### Field notes

| Field | Notes |
|---|---|
| `schema_version` | Currently `1`. Bumps when the wire shape changes incompatibly. |
| `sequence` | Monotonic per-event counter. Resets on server restart — bridges should treat a regression as a re-sync signal and reload via the HTTP endpoint. |
| `emitted_at` | ISO 8601 UTC timestamp. Use for staleness detection. |
| `event.on_hold` | `true` when the meet manager has held this event. Display a HOLD banner; pause animations. |
| `active_diver` | `null` when no diver is on the board (between dives, pre-event). Display the leaderboard full-screen. |
| `active_dive` | `null` when the diver hasn't picked their dive yet (rare — usually only mid-edit). |
| `scores` | One slot per judge on the panel, ordered by `judge_number`. `null` entries are pending judges. Display empty boxes for `null`. |
| `dive_total` | `null` until every judge has scored. Then it carries the post-trim DD-multiplied total for this dive. |
| `current_rank` / `field_size` | The active diver's place in the event. Display as `1/14`. |
| `leaderboard` | Top 8 by running total. Empty until the first dive lands. |

## Writing a custom bridge

Use the built-in Daktronics bridge when the venue accepts RTD / ERTD. For any other hardware, the bridge is just a Socket.IO (or HTTP) client that subscribes to one event and translates JSON to vendor packets. Here's a minimal Node skeleton you can adapt:

```js
// venue-bridge.js — minimal scaffold
const { io } = require('socket.io-client')
const SerialPort = require('serialport') // for Daktronics RTD over RS-232

const socket = io('https://divinghq.app', {
  transports: ['websocket'],
})

socket.on('connect', () => {
  socket.emit('subscribe_venue', { event_id: process.env.EVENT_ID })
})

const port = new SerialPort({
  path: '/dev/ttyUSB0',
  baudRate: 19200,            // Daktronics AllSport default
})

socket.on('venue.scoreboard_state', (state) => {
  // Translate `state` into your hardware's protocol. For Daktronics
  // RTD, build the line-mapped packet and write to the serial port.
  const packet = buildRtdPacket(state)   // vendor-specific
  port.write(packet)
})
```

## Hardware target compatibility matrix

| Vendor / Model | Protocol | Bridge complexity |
|---|---|---|
| Daktronics AllSport 5000 / 5100 | RTD (Real-Time Data) over RS-232/485 | Supported by the bundled bridge's serial output; venue-specific RTD template still required |
| Daktronics AllSport Pro | RTD / ERTD network feed | Supported by the bundled bridge's UDP output |
| Daktronics Data Studio / Show Control / DMP workflows | RTD / ERTD fields or JSON fields | Supported by bundled fixed-width RTD or JSON output |
| Colorado Time Systems CTS-5 | Serial CTS protocol | Medium |
| OmegaTiming OSM7 / OSV9 | Proprietary serial | High — vendor support recommended |
| ALGE Timy | Serial | Medium |
| Custom NDI / HDMI feed | NDI SDK | Low (with NDI tools) |

## Testing without hardware

Even without real hardware to test against, you can verify the payload contract:

1. Open a meet on a dev environment.
2. In Control Room, open **Broadcast → Venue hardware — Daktronics bridge...**.
3. Copy the **Test output** command and run it from the project folder.
4. Confirm it prints one fixed-width ASCII RTD line.

For lower-level payload testing, subscribe via `wscat`:
   ```
   wscat -c "wss://localhost/socket.io/?EIO=4&transport=websocket"
   ```
Or use the HTTP endpoint:

```bash
curl https://localhost/api/venue/scoreboard-state/<event_id>
```

Then drive the meet from the Control Room — set active diver, submit scores, hold/resume — and confirm every state transition emits a fresh `venue.scoreboard_state` event with monotonically-increasing `sequence`.

The payload is fully exercised by the regular meet workflow — no special test mode required.

## Security posture

The venue endpoint is **unauthenticated** by design. The same data is on `/scoreboard/:id` (the public spectator scoreboard) already, and the bridge runs inside the venue's own LAN where exposing the payload is intentional.

If your federation needs auth (e.g. multi-tenancy concerns where venue bridges might cross-poll other federations' events), open a feature request — we can add a bridge-token gate without changing the wire shape.

## Roadmap

- **Colorado Time Systems CTS-5 driver.** Common in combined swim/dive venues.
- **NDI output.** For venues with LED video walls instead of fixed-segment boards.
