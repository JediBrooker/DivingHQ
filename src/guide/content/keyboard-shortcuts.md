# Keyboard Shortcuts

## Control Room (`/control`)

The multi-event Control Room is fully keyboard-drivable. The trick to running several pools at once without a keypress landing on the wrong event: **every hotkey acts on the _focused_ pool only**, and the **number keys** are what change which pool is focused. So the operator's rhythm is "pick a pool with a number, then drive it" — and each pool can still be driven by mouse/touch at the same time.

| Key | Action |
|---|---|
| **1** … **9** | Switch the focused pool. `1` is the first live pool, `2` the second, and so on (oldest-started first — the same order the chips and pool cards appear in). |
| **Space** or **→** | Advance the focused pool to the next diver (or **Finalise** on the last dive). |
| **H** | Hold / resume the focused pool — pauses its shot clock and active-diver banner. |
| **L** | Announce — push the focused pool's standings to the public scoreboard. |
| **F** | Referee: mark the focused pool's current dive **Failed** (0 across the board). |
| **R** | Referee: grant the focused pool's current diver a **Re-dive**. |
| **C** | Referee: **Cap** the focused pool's current dive scores at 2.0. |

**Notes**

- Hotkeys are ignored while you're typing in a text field, a `<select>`, or the command palette — so typing a diver's name or a search query never advances a pool.
- Modifier combos (Cmd/Ctrl/Alt) are left alone for the browser and the command palette (e.g. **Cmd-K / Ctrl-K**).
- Every hotkey has an on-screen equivalent too, so you can mix keyboard and mouse: the **Next Diver → / Finalise** button (and the **Auto-next** `▾` aside) on each pool card, the **Failed · Cap 2.0 · Re-dive** row, the **⏸ Hold** button, the **Announce** button in the Standings column, and the event **chips** (or **All events** dropdown) in the top bar.

## Scoreboard / Diver views

The audience-facing scoreboard, the diver portal, and the diver profile don't currently use keyboard shortcuts — they're built for touch and mouse. If you need keyboard navigation for accessibility, the standard browser shortcuts work (Tab, Enter, arrows in form controls).

## Browser-level shortcuts worth knowing

These work in any view, not just DivingHQ, but they pair nicely with specific surfaces:

| Shortcut | Used for |
|---|---|
| **Cmd-P / Ctrl-P** | Export the diver-profile dashboard or any scoreboard view to PDF |
| **F11** | Full-screen the browser — turns any view into a kiosk |
| **Cmd-Shift-T / Ctrl-Shift-T** | Reopen the last closed tab — useful if you accidentally close the Control Room mid-meet |

For projector / venue use, **Broadcast mode** (`?broadcast=1` on `/control` or `/scoreboard/<id>`) hides the chrome automatically — F11 isn't needed.
