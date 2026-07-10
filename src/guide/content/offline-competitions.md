# Offline Competitions

DivingHQ is built to keep running even when venue Wi-Fi drops mid-meet. Every action that matters during a live competition — judge score submissions, advancing to the next diver, referee calls, holds and resumes — is queued locally before being sent to the server. If the network is unavailable, operations stack up on the device and replay automatically when connectivity returns. No scores are lost, and no one needs to do anything special to make it work.

## How it works

### The outbox

Every write operation goes through an **outbox** backed by IndexedDB, the browser's built-in persistent storage. When a judge taps Submit or an operator clicks Next Diver, the action is written to the outbox first, then sent to the server. If the send succeeds, the entry is marked as synced. If the network is down, the entry stays in the queue and waits.

Because the outbox uses IndexedDB (not in-memory state), queued operations are **durable** — they survive page refreshes, navigation between views, and even closing and reopening the browser. A queued score written at 10:14 am is still there if you reopen the tab at 10:20 am.

Entries are retained for up to 72 hours, matching the server-side idempotency window. Each operation carries a unique idempotency key, so even if the same action is sent twice (e.g., after a reconnect race), the server applies it exactly once.

### Connection indicator

The Control Room top bar shows a real-time connection indicator on the right side, next to the History and Standings buttons.

| Indicator | Meaning |
|---|---|
| **Green dot + "Online"** | Connected to the server. Operations send immediately. |
| **Amber dot + "Offline"** (pulsing) | Connection lost. Operations are queuing locally. The indicator shows how long you've been offline (e.g., "Offline 2m"). |

When operations are queued, a **badge** appears next to the indicator showing the pending count — e.g., "3" means three operations are waiting to send. If any operations fail after all retries, a red badge appears so you know something needs attention.

![The Control Room top bar with the connection indicator flipped to an amber Offline pill and a badge showing queued operations](/guide-screenshots/offline-connection-indicator.png)

### Automatic sync

When the connection comes back, the outbox drains automatically — no button to press, no manual intervention. Operations replay in the exact order they were performed (FIFO), so a sequence like "submit score → advance diver → submit score" applies correctly on the server. You'll see the pending count tick down as each operation confirms.

Each operation retries up to 5 times with exponential backoff (1 second, 2 seconds, 4 seconds, up to 16 seconds between attempts). If an operation still fails after all 5 attempts, it's marked as failed and surfaced in the UI so you can investigate. In practice, transient failures almost always resolve on the first or second retry once the network is back.

## For judges

- Open the judging page while connected — it loads the event data, dive lists, and panel configuration up front.
- If the connection drops mid-meet, **keep scoring normally**. The submit button works the same way regardless of connectivity. Scores queue locally and sync when Wi-Fi returns.
- The judge view shows connection status so you always know whether scores are being sent live or queued.
- When the connection returns, your queued scores replay in order. You don't need to resubmit anything.

The most important thing: **a dropped connection during scoring is not an emergency.** The system was designed for exactly this situation. Score normally and let the outbox handle the rest.

## For meet managers (Control Room)

- The Control Room shows the connection indicator in the top bar, visible at all times. Glance at it periodically — green means everything is flowing; amber means you're queueing.
- All operations go through the outbox: advance diver, hold/resume, referee actions (failed dive, cap scores, re-dive), and score announcements.
- If you advance to the next diver while offline, the operation queues and executes when connectivity returns. The server applies the state change, and connected judges receive the updated active diver.
- Multiple operations can queue — they replay in order. If you advanced three divers while offline, all three transitions apply in sequence.
- The pending count badge tells you how many operations are waiting. If it's climbing, you're offline but operational. If it ticks down, the connection is back and draining.

## What doesn't work offline

- **Initial page load.** The judging page and Control Room need to fetch event data, dive lists, and panel configuration from the server on first load. Once loaded, they can operate offline.
- **Live scoreboard updates.** The audience-facing scoreboard is read-only and needs a live socket connection to receive score updates. Queued scores appear on the scoreboard once they sync.
- **Admin operations.** User management, fee configuration, event creation, and other admin tasks require a live connection. These aren't time-critical during a meet.

## Best practices for venue Wi-Fi

- **Test Wi-Fi at the venue before the meet.** Walk the pool deck with a phone — check signal strength at the judges' seating, the Control Room operator's position, and anywhere a tablet might be used.
- **Use a dedicated network for officials** if possible. Spectators streaming video on the same access point will degrade performance for everyone.
- **Position access points** near the judges' seating and Control Room operator, not just in the lobby.
- **Bring a mobile hotspot as backup.** A phone hotspot can keep a meet running if venue Wi-Fi fails entirely.
- **Brief judges before the meet starts.** They should know that an amber indicator means "your scores are queued, keep going" — not "something is broken, stop scoring."
- **Install the PWA.** DivingHQ can be installed as a Progressive Web App on phones and tablets for faster reconnection and a more reliable experience on flaky networks.

## What to do if something goes wrong

| Situation | What happens |
|---|---|
| A judge's device shows offline for an extended period | Scores are safe in the local queue. They replay automatically when connectivity returns. |
| A device runs out of battery or crashes mid-meet | Queued scores in IndexedDB persist across browser restarts. Charge the device, reopen the browser, navigate back to the judging page — the queue resumes draining. |
| A device is physically destroyed | Use the paper backup. The meet manager can re-enter scores from the paper judging cards using the [score correction modal](/guide/running-a-meet#correcting-a-score) in the Control Room. |
| The pending count stays high after reconnecting | The outbox is retrying. Give it 30 seconds. If the count doesn't drop, check whether the server is reachable (the issue may be upstream, not local). |
| A failed badge (red) appears | An operation exhausted its 5 retry attempts. Check the Control Room for details. The most common cause is a server-side conflict (e.g., two operators advancing the same event), which can be resolved from the conflict tray. |

## Technical details

For the technically curious:

- The outbox uses **IndexedDB** (`divinghq-outbox` database), not localStorage. IndexedDB is durable, has no practical size limit for this use case, and doesn't block the main thread.
- Operations are sent via **Socket.IO** with acknowledgment callbacks — the server acks each operation so the outbox knows it was received. If the socket is unavailable, operations fall back to **HTTP POST** with an idempotency key header.
- Retry uses **exponential backoff** — 1s, 2s, 4s, 8s, 16s between attempts, capped at 5 attempts total.
- **FIFO ordering** guarantees operations apply in the sequence the operator performed them. An advance-then-hold replays as advance-then-hold, never the reverse.
- Each operation carries a **UUID v4 idempotency key**. The server's idempotency table (72-hour retention) deduplicates replayed operations, so a reconnect race never double-applies a score.
- The outbox is **scoped per user** — logging out and logging in as a different user on the same device doesn't drain the first user's queue.

## Next steps

- [Running a Meet](/guide/running-a-meet) — the full Control Room guide
- [Judging](/guide/judging) — what judges see during scoring
- [Quick Start](/guide/quick-start) — setting up your first event
