# Simultaneous event corrections

Plan agreed and implemented on 9 October 2026. Private testing release: **1.2 (3)** for
iPhone, iPad, Android phones and Android tablets, using `https://divinghq.app`.
Implementation and verification are complete at source
`4c1cfbe838db63de4fe509b4d5624ffa88250243`. Local lint/build, 1,606 Node/integration
and 456 Playwright checks passed, with native phone/tablet checks recorded in the
[release evidence](native-release-evidence-2026-10-09.md#simultaneous-event-release--12-3).
Both stores report the owner-only update available. The matching backend was
deployed through `deploy.sh` after a fresh zero-Live-events check and verified
healthy at the same source, schema 105. Physical/store-installed 1.2 acceptance
is not claimed.

## Judge event selection

Opening the Judge Terminal without an event must never choose arbitrarily
between multiple live assignments. One live assignment can open automatically;
multiple assignments require an explicit choice with enough event and meet
context to distinguish them. An event link selects its named assignment.

Switching events clears the previous event's keypad, panel, hold and referee
state before loading the new event. Late responses and broadcasts from other
events cannot replace that selection. A terminal with no selected event ignores
event-specific live state. Existing queued judge scores retain their original
event and diver; changing the screen must not retarget or silently discard them.

## One operator advances each event

Opening a Control Room observes its events. It does not claim all live events or
announce a diver merely because a card appeared. An operator explicitly takes
control of an event. Separate events can have separate operators, and one
operator can control several events. Another device, including a second device
using the same account, observes the current state until an authorized operator
explicitly takes over.

The server enforces ownership for active-diver progression and finalisation.
Modern clients use a per-socket lease with a heartbeat and a generation token;
takeover, release, expiry and disconnect invalidate the previous authority.
Tokens stay in memory and must never enter public broadcasts, persisted active
state or the offline outbox. Authorization, organisation boundaries, maintenance
mode, token revocation and rate limits still apply independently of ownership.

Referee calls and event hold/resume retain their existing authorization. A
referee on a separate device must be able to do that work without taking the
operator's progression control. Existing score-authority checks also remain.

Progression must be checked at the time of its actual mutation, including after
an awaited roster read, confirmation or database operation. Takeover and
finalisation cannot race a stale active-diver write into the event. An observer
follows subsequent server cursor updates, not just the first snapshot.

### Compatibility with installed 1.1 (2)

The installed 1.1 (2) packages contain their own bundled interface; deploying the
website does not upgrade their controls. Existing legacy sockets may claim a
free event and drive its cursor under exclusive per-socket ownership. Their
leases are tied to the socket connection because those clients do not send
modern heartbeats. They cannot overwrite another socket's owner.

There is no user-ID-only fallback for HTTP finalisation: it cannot distinguish
two devices signed in to the same account. Leaving Live, or changing status while
an active control lease exists, needs the current token. An older client receives
an actionable conflict response explaining that it needs updated controls.
Reading and judging remain available. Starting an unclaimed Upcoming event or
reopening an unclaimed Completed event retains the existing permission rules.
An expired or released lease does not allow a queued legacy finalisation through.

Old queued progression must not regain authority after reconnect, takeover or
manual Retry. The new client cancels obsolete queued progression and sends new
progression with an acknowledgement rather than replaying it later. Judge-score
offline handling remains in place.

## Background and connection safety

Backgrounding, losing the connection or losing ownership stops automatic
advancement. Returning to the app refreshes the event's server state and requires
an explicit resume before automation can run again. A delayed timer callback
must not skip a diver on return. This applies independently to each event.

On loss of control the clock stops and displays a dash. Regaining control does
not silently restart a full minute or imply that elapsed time was preserved;
the operator must deliberately restart the local clock after checking the event.
This does not make the app the authority for a referee's warning or create an
automatic failed-dive decision. Native lifecycle notifications and browser
visibility changes must both be considered in verification.

## Scope boundaries

This work does not add a server that automatically runs the meet while all
operators are away. It does not change scoring, panels, dive order rules, stage
progression rules or the referee's decisions. The relevant World Aquatics
judging and referee sections were read before review; no new rules citation or
scoring interpretation is needed for these concurrency controls.

Native notifications, Settings, sharing, printing, app links and authentication
remain part of the existing implementation. The verified 1.1 (2) push results
are preserved in the [release evidence](native-release-evidence-2026-10-09.md):
real Android emulator delivery and owner-confirmed physical iOS receipt with a
tap into Settings. Those results do not constitute verification of 1.2 (3).
Physical Android delivery remains unverified.

## Verification matrix

| Scenario | Required result |
|---|---|
| No event, one live judge assignment, several live assignments | Waiting, automatic single assignment, or explicit choice respectively; no arbitrary newest-event selection. |
| Judge changes events while responses are delayed | The selected event wins; scores, hold, signals and panel state from the old event cannot cross over. |
| Judge has queued scores for an earlier event | They retain their event/diver identity and remain visible or otherwise accounted for. |
| Two events, two operators | Each can advance its own event without changing the other. |
| Same event, different operators or two devices on one account | Only the owning socket can progress or finalise; observers continue receiving updates. |
| Authorized referee on another device | Referee calls and hold/resume still work under their existing gates. |
| Control Room opened only to observe | No automatic claim, seed announcement or progression occurs. |
| Explicit takeover during delayed progression or finalisation | The obsolete owner cannot commit a later write; tokens are not exposed publicly. |
| Owner disconnects, expires or releases control | Another authorized operator can recover control without stale work replaying. |
| Background, disconnect or ownership loss during countdown | Countdown stops, late callbacks cannot advance, refreshed state precedes explicit resume. |
| Old queued progression and manual Retry | It cannot overwrite the current event state after ownership changes. |
| Legacy 1.1 (2) socket and HTTP requests | Safe cursor compatibility works; unsupported finalisation receives an actionable refusal without an account-only bypass. |
| Cross-organisation, revoked account or maintenance mode | Existing authorization and fail-closed behaviour remain intact. |
| Completed event and concurrent active-diver update | Completion cannot be followed by stale live state being restored. |
| Phone/tablet UI and native lifecycle | Event choice, owner/observer state and resume controls remain usable at each supported size. |

Run the required local lint, build, Node/integration and Playwright checks before
commit and push. Focused tests should exercise competing requests and delayed
responses, not merely assert that the new controls are rendered. Native builds
must retain the explicit production API origin, signing and platform settings.

## Rollout gates

Prepare, verify and make **1.2 (3)** available to the existing owner-only
TestFlight and Play internal audiences before deploying enforcement that older
clients cannot satisfy. Check active production events immediately before the
backend deployment; do not introduce the control transition during a running
event. Use the normal deployment and health verification process, preserving
provider credentials and feature flags.

Record exact source, tests, signed artifacts, store processing and compatibility
limitations in the release evidence. Distinguish emulator checks from physical
device results and published availability from installation. Do not broaden the
testing audience or publish a public production release as part of this work.
