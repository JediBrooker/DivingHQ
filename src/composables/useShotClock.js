/* Shot clock: World Aquatics Article 8.5.5, "If the Athlete
 * does not dive within ONE (1) MINUTE after the Referee has
 * issued a warning [per 8.5.4], the Referee will declare a
 * failed dive". The diver is given "sufficient time for
 * preparation and execution" before that warning per 8.5.4
 * (that's a Referee judgment call, not a fixed timer), so this
 * clock represents the post-warning 60-second window.
 *
 * Lifted out of the old all-in-one ControlView back when that file
 * crossed 7,500 lines. The clock is standalone: it owns its timer
 * handle and a tiny ref bundle. Each LivePoolCard makes its own, so
 * two pools never share a clock, and a meet-hold just resets it.
 *
 * Usage:
 *   const {
 *     shotClock, shotClockExpired, shotClockClass,
 *     startShotClock, stopShotClock, resetShotClock,
 *   } = useShotClock()
 */
import { ref, computed, onUnmounted } from 'vue'

export function useShotClock({ defaultSeconds = 60 } = {}) {
  const SHOT_CLOCK_DEFAULT = defaultSeconds
  const shotClock = ref(SHOT_CLOCK_DEFAULT)
  const shotClockExpired = ref(false)
  let shotClockTimer = null

  function startShotClock(seconds = SHOT_CLOCK_DEFAULT) {
    stopShotClock()
    shotClock.value = seconds
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

  // The card never stops the clock on its way out, so this is the
  // only thing between an unmounted pool and a setInterval that ticks
  // forever.
  onUnmounted(() => stopShotClock())

  return {
    shotClock,
    shotClockExpired,
    shotClockClass,
    startShotClock,
    stopShotClock,
    resetShotClock,
  }
}
