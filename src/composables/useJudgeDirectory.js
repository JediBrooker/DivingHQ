// The judge directory search that /judges and the By Judge tab of
// /judge-analysis both run: filters, paging, the federation dropdown and
// the "Showing 1-50 of N" line. The two views carried a line-for-line copy
// of this, with different error wording, which is the one thing a caller
// still passes in.
//
// It takes the auth store rather than importing it, so
// test/use-judge-directory.test.js can drive it under plain node (which
// can't resolve the '@/' alias). Only apiFetch and isLoggedIn are used.
import { ref, computed, watch } from 'vue'

export function useJudgeDirectory(auth, { errorText = 'Could not load directory' } = {}) {
  const q = ref('')
  const orgId = ref('')
  const countryCode = ref('')
  const offset = ref(0)
  const limit = ref(50)
  const rows = ref([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref('')
  const orgs = ref([])

  // Empty filters are left out so the URL stays minimal.
  function buildQS() {
    const parts = []
    if (q.value.trim()) parts.push(`q=${encodeURIComponent(q.value.trim())}`)
    if (orgId.value) parts.push(`org_id=${encodeURIComponent(orgId.value)}`)
    if (countryCode.value.trim()) {
      parts.push(`country_code=${encodeURIComponent(countryCode.value.trim().toUpperCase())}`)
    }
    parts.push(`limit=${limit.value}`)
    parts.push(`offset=${offset.value}`)
    return `?${parts.join('&')}`
  }

  async function load() {
    loading.value = true
    error.value = ''
    try {
      const body = await auth.apiFetch(`/api/judges/directory${buildQS()}`)
      rows.value = body.rows || []
      total.value = body.total ?? 0
    } catch (err) {
      error.value = err.message || errorText
      rows.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  // /api/orgs/all needs a session. Anonymous viewers go without the
  // federation dropdown and use the free-text country filter.
  async function loadOrgs() {
    if (!auth.isLoggedIn) return
    try {
      orgs.value = await auth.apiFetch('/api/orgs/all')
    } catch { /* dropdown stays empty */ }
  }

  function applyFilters() {
    offset.value = 0
    load()
  }
  function clearFilters() {
    q.value = ''
    orgId.value = ''
    countryCode.value = ''
    offset.value = 0
    load()
  }
  function nextPage() {
    if (offset.value + limit.value >= total.value) return
    offset.value += limit.value
    load()
  }
  function prevPage() {
    offset.value = Math.max(0, offset.value - limit.value)
    load()
  }

  const pageInfo = computed(() => {
    if (!total.value) return ''
    const from = offset.value + 1
    const to = Math.min(offset.value + rows.value.length, total.value)
    return `Showing ${from}–${to} of ${total.value}`
  })

  // Federation and country apply on change. The name search has its own
  // Apply button so it doesn't fire on every keystroke.
  watch([orgId, countryCode], () => {
    offset.value = 0
    load()
  })

  return {
    q, orgId, countryCode, offset, limit, rows, total, loading, error, orgs,
    load, loadOrgs, applyFilters, clearFilters, nextPage, prevPage, pageInfo,
  }
}
