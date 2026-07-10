import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// Client mirror of the server's feature_flags table (migration 085).
//
// Fetched once at boot from the public GET /api/features, before the app
// mounts, so the router guard and the sidebar both know which product areas
// exist on their very first read. There's no polling: a sysadmin flipping a
// flag changes what OTHER people see on their next page load, and the person
// doing the flipping gets the fresh value straight from the PUT response.
//
// Everything starts OFF and stays OFF if the fetch fails. A nav link that
// shows up a beat late is a shrug; one that flashes on screen and then
// vanishes, or worse leads to a checkout we meant to keep dark, is not.
export const useFeaturesStore = defineStore('features', () => {
  const flags = ref({ payments: false, classes: false, signups: false, maintenance: false })
  const loaded = ref(false)

  async function load() {
    try {
      const res = await fetch('/api/features', { credentials: 'same-origin' })
      if (res.ok) flags.value = { ...flags.value, ...(await res.json()) }
    } catch {
      // Offline or the API is down. Leave every flag off and carry on:
      // the rest of the app (scoreboard, judging) works without this.
    } finally {
      loaded.value = true
    }
    return flags.value
  }

  function enabled(key) {
    return flags.value[key] === true
  }

  // Local write-through for the admin toggle screen, so the sidebar and
  // router react the moment the PUT comes back rather than after a reload.
  function apply(key, on) {
    flags.value = { ...flags.value, [key]: on === true }
  }

  const payments = computed(() => enabled('payments'))
  const classes = computed(() => enabled('classes'))
  const signups = computed(() => enabled('signups'))
  const maintenance = computed(() => enabled('maintenance'))

  return { flags, loaded, load, enabled, apply, payments, classes, signups, maintenance }
})
