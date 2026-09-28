// The dive directory (GET /api/dive-directory), read through the per-user
// IDB cache. Every dive-list editor and the directory page itself need
// it, and each used to spell out the same cachedApiFetch call plus the
// unwrap of its { data, fromCache, age } result. One copy forgot the
// unwrap and broke the team picker, which is why this exists.
//
// reload() resolves once the rows are in `dives`, so a caller can keep it
// inside its own Promise.all / try. A background revalidation (the cached
// copy was served first) lands in `dives` through onUpdate. Errors
// propagate to the caller, which already has its own message for them.
//
// Takes the auth store rather than importing it, so the node test can run
// it (no '@/' alias there). Only auth.cachedApiFetch is used.
import { ref } from 'vue'
import { DIVE_DIRECTORY_TTL_MS } from '../lib/cache-policy.js'

export function useDiveDirectory(auth) {
  const dives = ref([])
  async function reload() {
    const result = await auth.cachedApiFetch('/api/dive-directory', {
      cache: {
        // 24h: the catalog only changes when an org adds a custom dive,
        // and that path invalidates the cache itself.
        maxAgeMs: DIVE_DIRECTORY_TTL_MS,
        onUpdate: (fresh) => { if (Array.isArray(fresh)) dives.value = fresh },
      },
    })
    dives.value = Array.isArray(result?.data) ? result.data : []
    return dives.value
  }
  return { dives, reload }
}
