/* Shot clock: World Aquatics Article 8.5.5, "If the Athlete
 * does not dive within ONE (1) MINUTE after the Referee has
 * issued a warning [per 8.5.4], the Referee will declare a
 * failed dive". The diver is given "sufficient time for
 * preparation and execution" before that warning per 8.5.4
 * (that's a Referee judgment call, not a fixed timer), so this
 * clock represents the post-warning 60-second window.
 *
 * Lifted out of ControlView.vue when that file crossed 7,500
 * lines and reading it through cost real agent tokens. The clock
 * is genuinely standalone: it owns its own timer handle and a
 * tiny ref bundle, and the only outside-world coupling is that
 * the Control Room reads .shotClockRunning to decide whether to
 * pause it on a meet-hold.
 *
 * Usage:
 *   const {
 *     shotClock, shotClockRunning, shotClockExpired,
 *     shotClockClass,
 *     startShotClock, stopShotClock, pauseShotClock, resetShotClock,
 *     SHOT_CLOCK_DEFAULT,
 *   } = useShotClock()
 */
import { ref, computed, onUnmounted } from 'vue'

export function useShotClock({ defaultSeconds = 60 } = {}) {
  const SHOT_CLOCK_DEFAULT = defaultSeconds
  const shotClock = ref(SHOT_CLOCK_DEFAULT)
  const shotClockRunning = ref(false)
  const shotClockExpired = ref(false)
  let shotClockTimer = null

  function startShotClock(seconds = SHOT_CLOCK_DEFAULT) {
    stopShotClock()
    shotClock.value = seconds
    shotClockRunning.value = true
    shotClockExpired.value = false
    shotClockTimer = setInterval(() => {
      shotClock.value--
      if (shotClock.value <= 0) {
        shotClock.value = 0
        shotClockExpired.value = true
        stopShotClock()
        // Audible beep removed: pool decks already have a horn /
        // referee whistle that the operator listens for, and the
        // visual .shot-clock-expired flash gives the same signal
        // without competing with the venue audio. shotClockExpired
        // still drives the colour change in the CSS.
      }
    }, 1000)
  }

  function stopShotClock() {
    if (shotClockTimer) { clearInterval(shotClockTimer); shotClockTimer = null }
    shotClockRunning.value = false
  }

  // Pause-toggle. Running → pause (keep remaining seconds); paused
  // (and not at zero) → resume on a fresh interval. Operator-bound
  // to spacebar via the keyboard map in the Control Room.
  function pauseShotClock() {
    if (shotClockRunning.value) {
      stopShotClock()
      return
    }
    if (shotClock.value > 0) {
      shotClockRunning.value = true
      shotClockTimer = setInterval(() => {
        shotClock.value--
        if (shotClock.value <= 0) {
          shotClock.value = 0
          shotClockExpired.value = true
          stopShotClock()
        }
      }, 1000)
    }
  }

  function resetShotClock() {
    stopShotClock()
    shotClock.value = SHOT_CLOCK_DEFAULT
    shotClockExpired.value = false
  }

  const shotClockClass = computed(() => {
    if (shotClockExpired.value) return 'shot-clock-expired'
    // Thresholds scaled to the 60-sec total: red at 10s, amber at 20s.
    if (shotClock.value <= 10) return 'shot-clock-warn'
    if (shotClock.value <= 20) return 'shot-clock-amber'
    return ''
  })

  // Belt-and-braces cleanup: the Control Room unmount path already
  // calls stopShotClock(), but just in case a future caller forgets,
  // a dangling setInterval would tick forever otherwise.
  onUnmounted(() => stopShotClock())

  return {
    SHOT_CLOCK_DEFAULT,
    shotClock,
    shotClockRunning,
    shotClockExpired,
    shotClockClass,
    startShotClock,
    stopShotClock,
    pauseShotClock,
    resetShotClock,
  }
}
