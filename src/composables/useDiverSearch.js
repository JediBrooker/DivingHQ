// The "find a diver" typeahead against GET /api/divers/search. The
// dashboard header, the command palette and both sides of Compare each
// had their own debounce + fetch + results block, and only the palette
// cancelled a request once a newer keystroke superseded it. The other
// two could paint an older, slower response over the newer one, or
// fill the list back in after the query had been cut below two chars.
//
// search(q) is called from the caller's input handler rather than a
// watcher of its own, because Compare writes the picked diver's name
// into the same box and that must not fire a search.
//
// Options keep the small differences the callers already had:
//   delay        debounce in ms
//   minChars     shorter queries clear the list and don't hit the API
//   trim         trim the query before checking and sending it (the
//                palette never did)
//   keepOnError  leave the last results up when a request fails (the
//                palette did; the others cleared)
//
// Takes the auth store rather than importing it, so the node test can
// run it. Only auth.apiFetch is used.
import { ref, getCurrentScope, onScopeDispose } from 'vue'

export function useDiverSearch(auth, { delay = 200, minChars = 2, trim = true, keepOnError = false } = {}) {
  const results = ref([])
  const loading = ref(false)
  let timer = null
  let inflight = null

  // Drop the pending debounce and abort whatever request is out.
  function cancel() {
    clearTimeout(timer)
    timer = null
    if (inflight) {
      inflight.abort()
      inflight = null
      loading.value = false
    }
  }

  function search(raw) {
    cancel()
    const q = trim ? String(raw ?? '').trim() : String(raw ?? '')
    if (q.length < minChars) {
      results.value = []
      return
    }
    timer = setTimeout(async () => {
      timer = null
      const ctrl = new AbortController()
      inflight = ctrl
      loading.value = true
      try {
        const rows = await auth.apiFetch(
          `/api/divers/search?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        )
        if (inflight === ctrl) results.value = Array.isArray(rows) ? rows : []
      } catch {
        if (inflight === ctrl && !keepOnError) results.value = []
      } finally {
        if (inflight === ctrl) {
          inflight = null
          loading.value = false
        }
      }
    }, delay)
  }

  function clear() {
    cancel()
    results.value = []
  }

  // Don't let a late response write into a component that's gone.
  if (getCurrentScope()) onScopeDispose(cancel)

  return { results, loading, search, clear, cancel }
}
