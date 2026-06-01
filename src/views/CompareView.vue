<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { fmtDate } from '@/lib/format'

// Side-by-side comparison of two divers across ANY organisation.
// Each side uses an autocomplete typeahead OR a "Browse" modal that
// lists every diver with org/club/country filters. Reuses the
// existing /api/divers/:id/profile endpoint, which now allows any
// authenticated user to view a diver's competitive history (the
// data was already public via the meet scoreboards).

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()

const profileA = ref(null)
const profileB = ref(null)
const loadingA = ref(false)
const loadingB = ref(false)
const errorA = ref('')
const errorB = ref('')

const idA = computed(() => route.query.a || '')
const idB = computed(() => route.query.b || '')

async function loadOne(id, side) {
  if (!id) {
    if (side === 'a') { profileA.value = null; errorA.value = '' }
    else              { profileB.value = null; errorB.value = '' }
    return
  }
  const setLoading = (v) => side === 'a' ? loadingA.value = v : loadingB.value = v
  const setError   = (v) => side === 'a' ? errorA.value = v   : errorB.value = v
  setLoading(true)
  setError('')
  try {
    const data = await auth.apiFetch(`/api/divers/${id}/profile`)
    if (side === 'a') profileA.value = data
    else              profileB.value = data
  } catch (err) {
    setError(err.message || 'Failed to load profile')
    if (side === 'a') profileA.value = null
    else              profileB.value = null
  } finally {
    setLoading(false)
  }
}

function selectDiver(side, diver) {
  // Accepts a diver object or just an id. Persists into the URL
  // so the comparison can be deep-linked or shared.
  const id = diver?.id || diver || ''
  const params = { ...route.query, [side]: id || undefined }
  if (!id) delete params[side]
  router.replace({ query: params })
  closeAutocomplete(side)
  closeBrowse()
}

// fmtDate imported from @/lib/format — single source of truth.

// Diff helpers — colour the higher value cyan, the other dim.
// Returns 'a' | 'b' | 'tie'.
function winner(a, b) {
  if (a == null && b == null) return 'tie'
  if (a == null) return 'b'
  if (b == null) return 'a'
  const an = Number(a), bn = Number(b)
  if (Number.isNaN(an) && Number.isNaN(bn)) return 'tie'
  if (Number.isNaN(an)) return 'b'
  if (Number.isNaN(bn)) return 'a'
  if (an > bn) return 'a'
  if (bn > an) return 'b'
  return 'tie'
}

const statRows = computed(() => {
  const a = profileA.value?.stats
  const b = profileB.value?.stats
  if (!a && !b) return []
  return [
    { label: 'Meets Entered',     a: a?.total_meets,      b: b?.total_meets,      higherIsBetter: true  },
    { label: 'Dives Performed',   a: a?.total_dives,      b: b?.total_dives,      higherIsBetter: true  },
    { label: 'Avg DD Attempted',  a: a?.avg_dd,           b: b?.avg_dd,           higherIsBetter: true,  fixed: 2 },
    { label: 'Best Single Dive',  a: a?.best_single_dive, b: b?.best_single_dive, higherIsBetter: true,  fixed: 1 },
  ]
})

// Personal-best comparison: for each (dive_code + position +
// height) the union of A's and B's PBs, joined so we can show
// best vs best per dive.
const pbCompare = computed(() => {
  const aMap = new Map()
  const bMap = new Map()
  for (const pb of profileA.value?.personal_bests || []) {
    aMap.set(`${pb.dive_code}|${pb.position}|${pb.height}`, pb)
  }
  for (const pb of profileB.value?.personal_bests || []) {
    bMap.set(`${pb.dive_code}|${pb.position}|${pb.height}`, pb)
  }
  const keys = new Set([...aMap.keys(), ...bMap.keys()])
  return [...keys]
    .map(k => ({ key: k, a: aMap.get(k), b: bMap.get(k) }))
    .sort((x, y) => {
      const xa = x.a || x.b, ya = y.a || y.b
      return (xa.dive_code || '').localeCompare(ya.dive_code || '') || (xa.position || '').localeCompare(ya.position || '')
    })
})

watch(idA, (v) => loadOne(v, 'a'), { immediate: true })
watch(idB, (v) => loadOne(v, 'b'), { immediate: true })

// =========================================================
// Autocomplete state per side. The text the user typed lives in
// queryA/queryB; a debounced watch fires the search and writes the
// results into resultsA/resultsB. The dropdown is shown when the
// input is focused AND there are >= 2 typed chars.
// =========================================================
const queryA   = ref('')
const queryB   = ref('')
const resultsA = ref([])
const resultsB = ref([])
const openA    = ref(false)
const openB    = ref(false)
let debounceA = null
let debounceB = null

function onInput(side) {
  const q = side === 'a' ? queryA.value : queryB.value
  const setOpen = (v) => side === 'a' ? openA.value = v : openB.value = v
  setOpen(true)
  if (side === 'a') clearTimeout(debounceA)
  else              clearTimeout(debounceB)
  // Empty query just clears; <2 chars doesn't fire a request.
  if (q.trim().length < 2) {
    if (side === 'a') resultsA.value = []
    else              resultsB.value = []
    return
  }
  const fire = () => runSearch(side, q.trim())
  if (side === 'a') debounceA = setTimeout(fire, 200)
  else              debounceB = setTimeout(fire, 200)
}

async function runSearch(side, q) {
  try {
    const rows = await auth.apiFetch(`/api/divers/search?q=${encodeURIComponent(q)}`)
    if (side === 'a') resultsA.value = Array.isArray(rows) ? rows : []
    else              resultsB.value = Array.isArray(rows) ? rows : []
  } catch {
    if (side === 'a') resultsA.value = []
    else              resultsB.value = []
  }
}

function closeAutocomplete(side) {
  // setTimeout so a click on a result row registers before blur
  // tears down the dropdown.
  setTimeout(() => {
    if (side === 'a') openA.value = false
    else              openB.value = false
  }, 150)
}

function clearSide(side) {
  if (side === 'a') queryA.value = ''
  else              queryB.value = ''
  selectDiver(side, null)
}

// =========================================================
// Browse modal — list every diver with org / country / club
// filters and a search box. Selecting a row resolves to that
// side and closes the modal.
// =========================================================
const browseOpen   = ref(false)
// Lock background scroll while the athlete-browse modal is open.
useBodyScrollLock().lockWhile(browseOpen)
const browseSide   = ref('a')         // which side the modal will set
const browseRows   = ref([])
const browseTotal  = ref(0)
const browseLimit  = 50
const browseOffset = ref(0)
const browseLoading = ref(false)
const browseQ        = ref('')
const browseOrgId    = ref('')
const browseCountry  = ref('')
let   browseDebounce = null
const orgs           = ref([])
const countryCodes   = computed(() => {
  const set = new Set()
  for (const o of orgs.value) if (o.country_code) set.add(o.country_code)
  return [...set].sort()
})

async function openBrowse(side) {
  browseSide.value   = side
  browseOpen.value   = true
  browseOffset.value = 0
  if (!orgs.value.length) {
    try { orgs.value = await auth.apiFetch('/api/orgs/all') }
    catch { orgs.value = [] }
  }
  await runBrowse()
}

function closeBrowse() { browseOpen.value = false }

async function runBrowse() {
  browseLoading.value = true
  try {
    const params = new URLSearchParams()
    if (browseQ.value.trim())   params.set('q', browseQ.value.trim())
    if (browseOrgId.value)      params.set('org_id', browseOrgId.value)
    if (browseCountry.value)    params.set('country_code', browseCountry.value)
    params.set('limit',  String(browseLimit))
    params.set('offset', String(browseOffset.value))
    const data = await auth.apiFetch(`/api/divers?${params.toString()}`)
    browseRows.value  = data.rows || []
    browseTotal.value = data.total || 0
  } catch {
    browseRows.value  = []
    browseTotal.value = 0
  } finally {
    browseLoading.value = false
  }
}

// Debounced re-search whenever a filter changes.
watch([browseQ, browseOrgId, browseCountry], () => {
  if (!browseOpen.value) return
  clearTimeout(browseDebounce)
  browseDebounce = setTimeout(() => {
    browseOffset.value = 0
    runBrowse()
  }, 200)
})

function nextPage() {
  if (browseOffset.value + browseLimit >= browseTotal.value) return
  browseOffset.value += browseLimit
  runBrowse()
}
function prevPage() {
  if (browseOffset.value === 0) return
  browseOffset.value = Math.max(0, browseOffset.value - browseLimit)
  runBrowse()
}

// Pre-populate the typed name when arriving with a query param so
// the user sees the picked diver's name in the input box.
async function syncDisplayName(id, side) {
  if (!id) {
    if (side === 'a') queryA.value = ''
    else              queryB.value = ''
    return
  }
  // The /profile call has already populated profileA/profileB;
  // mirror that name into the input so the user sees who's loaded.
  const which = side === 'a' ? profileA.value : profileB.value
  if (which?.diver?.full_name) {
    if (side === 'a') queryA.value = which.diver.full_name
    else              queryB.value = which.diver.full_name
  }
}
watch(profileA, () => syncDisplayName(idA.value, 'a'))
watch(profileB, () => syncDisplayName(idB.value, 'b'))

onMounted(async () => {
  // Pre-load the orgs list so the browse-modal filters open instantly.
  try { orgs.value = await auth.apiFetch('/api/orgs/all') }
  catch { orgs.value = [] }
})
</script>

<template>
  <div class="compare-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('compare.title') }}</div>
        <h1 class="page-title">Head-to-Head</h1>
        <div class="page-sub">
          {{ $t('compare.subtitle') }}
        </div>
      </div>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">{{ $t('compare.back') }}</RouterLink>
    </div>

    <!-- Pickers — autocomplete + browse, one per side -->
    <div class="picker-row">
      <div class="picker-side">
        <div class="picker-label-a">{{ $t('compare.pick_diver_a') }}</div>
        <div class="picker-input-wrap">
          <input
            class="input"
            type="text"
            placeholder="Type a name…"
            v-model="queryA"
            @input="onInput('a')"
            @focus="openA = true"
            @blur="closeAutocomplete('a')"
          >
          <button v-if="queryA" class="picker-clear" @click="clearSide('a')" v-tip="'Clear'">✕</button>
          <button class="btn btn-ghost btn-sm picker-browse" @click="openBrowse('a')">Browse</button>
          <ul v-if="openA && resultsA.length" class="autocomplete-list">
            <li
              v-for="d in resultsA"
              :key="d.id"
              class="autocomplete-item"
              @mousedown.prevent="selectDiver('a', d)"
            >
              <span class="ac-name">{{ d.full_name }}</span>
              <span class="ac-meta">
                {{ d.org_name }}<span v-if="d.country_code"> · {{ d.country_code }}</span>
                <span v-if="d.club_name"> · {{ d.club_name }}</span>
              </span>
            </li>
          </ul>
          <div v-else-if="openA && queryA.trim().length >= 2 && !resultsA.length"
               class="autocomplete-empty">
            No matches for "{{ queryA }}"
          </div>
        </div>
      </div>
      <div class="picker-vs">VS</div>
      <div class="picker-side">
        <div class="picker-label-b">{{ $t('compare.pick_diver_b') }}</div>
        <div class="picker-input-wrap">
          <input
            class="input"
            type="text"
            placeholder="Type a name…"
            v-model="queryB"
            @input="onInput('b')"
            @focus="openB = true"
            @blur="closeAutocomplete('b')"
          >
          <button v-if="queryB" class="picker-clear" @click="clearSide('b')" v-tip="'Clear'">✕</button>
          <button class="btn btn-ghost btn-sm picker-browse" @click="openBrowse('b')">Browse</button>
          <ul v-if="openB && resultsB.length" class="autocomplete-list">
            <li
              v-for="d in resultsB"
              :key="d.id"
              class="autocomplete-item"
              @mousedown.prevent="selectDiver('b', d)"
            >
              <span class="ac-name">{{ d.full_name }}</span>
              <span class="ac-meta">
                {{ d.org_name }}<span v-if="d.country_code"> · {{ d.country_code }}</span>
                <span v-if="d.club_name"> · {{ d.club_name }}</span>
              </span>
            </li>
          </ul>
          <div v-else-if="openB && queryB.trim().length >= 2 && !resultsB.length"
               class="autocomplete-empty">
            No matches for "{{ queryB }}"
          </div>
        </div>
      </div>
    </div>

    <!-- Loading / error states -->
    <div v-if="loadingA || loadingB" class="empty">Loading…</div>
    <div v-else-if="!profileA && !profileB" class="empty">
      Pick two divers above to see them head-to-head.
    </div>

    <!-- Comparison body -->
    <template v-else-if="profileA && profileB">
      <!-- Names -->
      <div class="names-row">
        <div class="name-card name-a">
          <div class="name-large">{{ profileA.diver.full_name }}</div>
          <div class="name-meta">
            {{ profileA.diver.org_name }}
            <span v-if="profileA.diver.country_code"> · {{ profileA.diver.country_code }}</span>
            <span v-if="profileA.diver.club_name"> · {{ profileA.diver.club_name }}</span>
          </div>
        </div>
        <div class="name-vs">VS</div>
        <div class="name-card name-b">
          <div class="name-large">{{ profileB.diver.full_name }}</div>
          <div class="name-meta">
            {{ profileB.diver.org_name }}
            <span v-if="profileB.diver.country_code"> · {{ profileB.diver.country_code }}</span>
            <span v-if="profileB.diver.club_name"> · {{ profileB.diver.club_name }}</span>
          </div>
        </div>
      </div>

      <!-- Headline stats -->
      <div class="stat-card">
        <div class="card-head">Headline Stats</div>
        <div v-for="row in statRows" :key="row.label" class="stat-row">
          <div :class="['stat-val', winner(row.a, row.b) === 'a' ? 'higher' : 'lower']">
            {{ row.a == null ? '—' : (row.fixed ? Number(row.a).toFixed(row.fixed) : row.a) }}
          </div>
          <div class="stat-label">{{ row.label }}</div>
          <div :class="['stat-val', winner(row.a, row.b) === 'b' ? 'higher' : 'lower']">
            {{ row.b == null ? '—' : (row.fixed ? Number(row.b).toFixed(row.fixed) : row.b) }}
          </div>
        </div>
      </div>

      <!-- Per-dive PB comparison -->
      <div v-if="pbCompare.length" class="stat-card">
        <div class="card-head">Personal Bests By Dive</div>
        <div class="pb-row pb-head">
          <div class="pb-cell pb-cell-a">Diver A</div>
          <div class="pb-cell pb-mid">Dive</div>
          <div class="pb-cell pb-cell-b">Diver B</div>
        </div>
        <div v-for="row in pbCompare" :key="row.key" class="pb-row">
          <div :class="['pb-cell', 'pb-cell-a', winner(row.a?.best_total, row.b?.best_total) === 'a' ? 'higher' : 'lower']">
            <span v-if="row.a">
              {{ Number(row.a.best_total).toFixed(1) }}
              <span class="pb-attempts">·  {{ row.a.attempts }} attempt{{ row.a.attempts === 1 ? '' : 's' }}</span>
            </span>
            <span v-else class="dim">—</span>
          </div>
          <div class="pb-cell pb-mid">
            <span class="pb-code">{{ (row.a || row.b).dive_code }} {{ (row.a || row.b).position }}</span>
            <span class="pb-height">{{ (row.a || row.b).height }}m</span>
          </div>
          <div :class="['pb-cell', 'pb-cell-b', winner(row.a?.best_total, row.b?.best_total) === 'b' ? 'higher' : 'lower']">
            <span v-if="row.b">
              {{ Number(row.b.best_total).toFixed(1) }}
              <span class="pb-attempts">·  {{ row.b.attempts }} attempt{{ row.b.attempts === 1 ? '' : 's' }}</span>
            </span>
            <span v-else class="dim">—</span>
          </div>
        </div>
      </div>
    </template>

    <!-- One side picked, other not yet -->
    <div v-else-if="profileA && !profileB" class="empty">
      Pick Diver B above to compare.
    </div>
    <div v-else-if="profileB && !profileA" class="empty">
      Pick Diver A above to compare.
    </div>

    <div v-if="errorA" class="msg msg-error">Diver A: {{ errorA }}</div>
    <div v-if="errorB" class="msg msg-error">Diver B: {{ errorB }}</div>
  </div>

  <!-- Browse modal — full filterable list of divers -->
  <div v-if="browseOpen" class="browse-backdrop" @click="closeBrowse"></div>
  <div v-if="browseOpen" class="browse-modal" @click.stop>
    <div class="browse-head">
      <div class="browse-title">
        Browse Divers
        <span class="browse-target">picking <strong>Diver {{ browseSide.toUpperCase() }}</strong></span>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closeBrowse">Close ✕</button>
    </div>
    <div class="browse-filters">
      <input
        class="input"
        type="text"
        placeholder="Search name…"
        v-model="browseQ"
      >
      <select class="select" v-model="browseCountry">
        <option value="">All countries</option>
        <option v-for="c in countryCodes" :key="c" :value="c">{{ c }}</option>
      </select>
      <select class="select" v-model="browseOrgId">
        <option value="">All organisations</option>
        <option v-for="o in orgs" :key="o.id" :value="o.id">{{ o.name }}</option>
      </select>
    </div>
    <div class="browse-body">
      <div v-if="browseLoading" class="empty-mini">Loading…</div>
      <div v-else-if="!browseRows.length" class="empty-mini">No divers match those filters.</div>
      <table v-else class="browse-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Organisation</th>
            <th>Club</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in browseRows" :key="d.id">
            <td class="strong">{{ d.full_name }}</td>
            <td>
              {{ d.org_name }}
              <span v-if="d.country_code" class="dim"> · {{ d.country_code }}</span>
            </td>
            <td>
              <span v-if="d.club_name">{{ d.club_name }}</span>
              <span v-else class="dim">—</span>
            </td>
            <td class="cell-action">
              <button class="btn btn-primary btn-sm" @click="selectDiver(browseSide, d)">
                Pick
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="browse-pager">
      <button class="btn btn-ghost btn-sm" :disabled="browseOffset === 0" @click="prevPage">← Prev</button>
      <span class="pager-info">
        {{ browseTotal === 0 ? '0' : `${browseOffset + 1}–${Math.min(browseOffset + browseLimit, browseTotal)} of ${browseTotal}` }}
      </span>
      <button class="btn btn-ghost btn-sm"
              :disabled="browseOffset + browseLimit >= browseTotal"
              @click="nextPage">Next →</button>
    </div>
  </div>
</template>

<style scoped>
.compare-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-header .btn { display: none; }
.page-title { font-family: var(--font-sans); font-size: var(--text-h1); font-weight: 600; font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.2; }
.page-sub   { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; max-width: 600px; }
.page-sub strong { color: var(--text-2); }

.picker-row {
  display: grid; grid-template-columns: 1fr auto 1fr;
  gap: 1rem; align-items: end;
  padding: 1rem 1.25rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); margin-bottom: 1.5rem;
}
.picker-side { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.picker-label-a, .picker-label-b {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase;
}
.picker-label-a { color: var(--cyan); }
.picker-label-b { color: var(--green, #10b981); }
.picker-vs {
  font-family: var(--font-sans); font-size: 18px; font-weight: 600;
  font-style: normal; letter-spacing: -0.01em; color: var(--fg-2); padding-bottom: 0.5rem;
}

/* Picker input + autocomplete */
.picker-input-wrap {
  position: relative;
  display: flex; align-items: center; gap: 0.4rem;
}
.picker-input-wrap > .input { flex: 1; padding-inline-end: 2rem; }
.picker-clear {
  position: absolute; inset-inline-end: 5.5rem; top: 50%; transform: translateY(-50%);
  background: transparent; border: none;
  color: var(--text-3); cursor: pointer;
  font-size: 12px; padding: 0.2rem 0.4rem;
}
.picker-clear:hover { color: var(--text); }
.picker-browse { flex-shrink: 0; }
.autocomplete-list {
  position: absolute; top: 100%; inset-inline-start: 0; inset-inline-end: 0; z-index: 10;
  margin-top: 0.3rem; padding: 0;
  background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  box-shadow: 0 12px 32px rgba(0,0,0,0.4);
  max-height: 320px; overflow-y: auto; list-style: none;
}
.autocomplete-item {
  padding: 0.55rem 0.875rem;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  display: flex; flex-direction: column; gap: 0.15rem;
}
.autocomplete-item:last-child { border-bottom: none; }
.autocomplete-item:hover { background: var(--bg-3); }
.ac-name { font-family: var(--font-display); font-weight: 700; color: var(--text); font-size: 13px; }
.ac-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); }
.autocomplete-empty {
  position: absolute; top: 100%; inset-inline-start: 0; inset-inline-end: 0; z-index: 10;
  margin-top: 0.3rem; padding: 0.6rem 0.875rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }
.empty-mini { color: var(--text-3); padding: 1rem 0; font-family: var(--font-mono); font-size: 12px; text-align: center; }

.names-row {
  display: grid; grid-template-columns: 1fr auto 1fr;
  gap: 1rem; align-items: center; margin-bottom: 1.25rem;
}
.name-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.25rem 1.5rem;
}
.name-card.name-a { border-color: rgba(6,182,212,0.4);  background: rgba(6,182,212,0.05); }
.name-card.name-b { border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.05); }
.name-large { font-family: var(--font-sans); font-size: 26px; font-weight: 600; font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.1; }
.name-meta  { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; }
.name-vs    { font-family: var(--font-sans); font-size: 22px; font-weight: 600; font-style: normal; color: var(--fg-3); }

.stat-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.25rem 1.5rem;
  margin-bottom: 1.25rem;
}
.card-head {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 1rem;
}

.stat-row {
  display: grid; grid-template-columns: 1fr 200px 1fr;
  align-items: center; gap: 1rem; padding: 0.6rem 0;
  border-top: 1px solid var(--border);
}
.stat-row:first-of-type { border-top: none; }
.stat-val {
  font-family: var(--font-mono); font-size: 28px; font-weight: 500;
  font-style: normal; line-height: 1; text-align: center;
}
.stat-val.higher { color: var(--cyan); }
.stat-val.lower  { color: var(--text-3); }
.stat-row > .stat-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  text-align: center;
}

.pb-row {
  display: grid; grid-template-columns: 1fr 200px 1fr;
  gap: 1rem; padding: 0.55rem 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.pb-row:first-of-type { border-top: none; }
.pb-head { font-family: var(--font-display); font-size: 9px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3); }
.pb-cell { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.pb-cell-a { justify-content: flex-end; font-family: var(--font-mono); }
.pb-cell-b { font-family: var(--font-mono); }
.pb-cell-a.higher, .pb-cell-b.higher { color: var(--cyan); font-weight: 700; }
.pb-cell-a.lower,  .pb-cell-b.lower  { color: var(--text-3); }
.pb-mid { justify-content: center; text-align: center; }
.pb-code { font-family: var(--font-mono); font-weight: 700; color: var(--text); }
.pb-height { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.pb-attempts { font-size: 10px; color: var(--text-3); font-weight: 400; }

.dim { color: var(--text-3); }

/* =========================================================
   Browse modal
   ========================================================= */
.browse-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(3, 7, 18, 0.55);
  -webkit-backdrop-filter: blur(2px);  /* iOS Safari */
  backdrop-filter: blur(2px);
}
.browse-modal {
  position: fixed; top: 50%; inset-inline-start: 50%; transform: translate(-50%, -50%);
  z-index: 100;
  width: min(900px, calc(100vw - 2rem));
  /* `dvh` not `vh` so the modal shrinks with the iOS Safari
     URL/toolbar rather than being clipped behind it — otherwise
     the bottom rows of the dive-browse table can sit physically
     under the toolbar and be unreachable. vh fallback first
     for browsers older than ~Q4-2022. */
  height: min(640px, calc(100vh - 2rem));
  height: min(640px, calc(100dvh - 2rem));
  background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45);
  display: flex; flex-direction: column; overflow: hidden;
}
.browse-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
}
.browse-title {
  font-family: var(--font-sans); font-size: 18px; font-weight: 600;
  font-style: normal; letter-spacing: -0.01em; color: var(--fg);
}
.browse-target {
  font-family: var(--font-mono); font-size: 11px; font-style: normal;
  font-weight: 400; color: var(--text-3); margin-inline-start: 0.6rem;
}
.browse-target strong { color: var(--cyan); }
.browse-filters {
  display: grid; grid-template-columns: 2fr 1fr 1.5fr;
  gap: 0.6rem; padding: 0.875rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
/* `overflow-x: clip` prevents the spec's promote-to-auto from
   making the body silently horizontally scrollable whenever a
   wide table cell exceeds the modal's width. */
.browse-body { flex: 1; overflow-y: auto; overflow-x: clip; padding: 0; }
.browse-table {
  width: 100%; border-collapse: collapse;
}
.browse-table th {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  text-align: start; padding: 0.6rem 1.25rem;
  background: var(--bg-3); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 1;
}
.browse-table td {
  padding: 0.55rem 1.25rem; border-bottom: 1px solid var(--border);
  font-size: 13px; vertical-align: middle;
}
.browse-table td.strong { color: var(--text); font-weight: 700; }
.browse-table td.dim    { color: var(--text-3); }
.browse-table tr:hover td { background: var(--bg-3); }
.cell-action { text-align: end; width: 80px; }

.browse-pager {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.75rem 1.25rem; border-top: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.pager-info { letter-spacing: 0.05em; }

@media (max-width: 720px) {
  .compare-wrap { padding: 1rem; }
  .picker-row, .names-row, .stat-row, .pb-row {
    grid-template-columns: 1fr;
  }
  .picker-vs, .name-vs { display: none; }
  .stat-row > .stat-label { order: -1; }
  .stat-val { font-size: 22px; text-align: start; }
  .pb-cell-a, .pb-cell-b { justify-content: flex-start; }
  .pb-mid { text-align: start; }

  .picker-clear { inset-inline-end: 5rem; }
  .browse-filters { grid-template-columns: 1fr; }
  /* vh fallback first for browsers older than ~Q4-2022. */
  .browse-modal { height: 92vh; height: 92dvh; }
}
</style>
