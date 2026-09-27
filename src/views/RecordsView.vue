<script setup>
// Public record books at /records/:scope?/:id?
//
// Four books per country: national (the federation), region (state,
// province...), club, and continental, each split into Women's and
// Men's (migration 094). Personal bests aren't here on purpose, the
// diver profile already has a richer widget for those.
//
// The URL is the state. Book, country (?org), height, dive-code prefix
// (?q) and the Women/Men toggle (?gender) all live in it, so a link to
// a filtered book *is* that book, and every control just rewrites the
// URL with router.replace. Anyone can read these, signed in or not:
// every mark on them already sits on a public scoreboard.
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { diveDescription } from '@/composables/useDiveLabel'
import { fmtDate } from '@/lib/format'
import EmptyState from '@/components/EmptyState.vue'
import LogoMark from '@/components/LogoMark.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { t, locale } = useI18n()

const SCOPES = ['federation', 'region', 'club', 'continental']
const CONTINENTS = ['africa', 'americas', 'asia', 'europe', 'oceania']
// UN M49 area codes. Intl.DisplayNames names them in whatever language
// the viewer reads, which beats shipping five more keys to 26 locales.
const CONTINENT_M49 = { africa: '002', americas: '019', asia: '142', europe: '150', oceania: '009' }
const HEIGHTS = ['0m', '1m', '3m', '5m', '7.5m', '10m']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LAST_BOOK_KEY = 'divinghq.records.last_book'

// ---- what the URL says ----------------------------------------------

const scope = computed(() => (SCOPES.includes(route.params.scope) ? route.params.scope : null))
const bookId = computed(() => {
  const id = String(route.params.id || '')
  if (!scope.value || !id) return null
  if (scope.value === 'continental') return CONTINENTS.includes(id) ? id : null
  return UUID_RE.test(id) ? id : null
})
const gender = computed(() => (route.query.gender === 'Male' ? 'Male' : 'Female'))
const height = computed(() => (HEIGHTS.includes(route.query.height) ? route.query.height : null))
const q = computed(() => String(route.query.q || ''))

// ---- data -------------------------------------------------------------

const orgs = ref([])
const clubs = ref([])
const clubsLoaded = ref(false)
const regions = ref({ label: null, regions: [] })
const rows = ref([])
const loading = ref(false)
const error = ref(false)

// Which country the pickers show. The URL's ?org wins; a national book
// is its own country; failing both, the book's rows know (a bare
// /records/club/<id> link shared from somewhere).
const orgId = computed(() => {
  const fromQuery = String(route.query.org || '')
  if (UUID_RE.test(fromQuery)) return fromQuery
  if (scope.value === 'federation' && bookId.value) return bookId.value
  return rows.value.find((r) => r.book_org_id)?.book_org_id || null
})

const bookReady = computed(() => !!(scope.value && bookId.value))

function orgLabel(o) {
  return o.country_code ? `${o.name} · ${o.country_code}` : o.name
}

function continentName(key) {
  try {
    const names = new Intl.DisplayNames([locale.value], { type: 'region' })
    return names.of(CONTINENT_M49[key]) || key
  } catch {
    return key.charAt(0).toUpperCase() + key.slice(1)
  }
}

const regionLabel = computed(() => t(`regions.label.${regions.value.label || 'region'}`))

const tabs = computed(() => [
  { key: 'federation', label: t('records.book_national') },
  ...(regions.value.regions.length || scope.value === 'region'
    ? [{ key: 'region', label: regionLabel.value }]
    : []),
  { key: 'club', label: t('records.book_club') },
  { key: 'continental', label: t('records.book_continental') },
])

// What to call the book in the heading and the Unofficial note. The
// pickers know the name before any rows arrive, and an empty book has
// no rows to ask.
const bookName = computed(() => {
  if (!bookReady.value) return ''
  const fromRows = rows.value[0]?.scope_name || ''
  switch (scope.value) {
    case 'continental': return continentName(bookId.value)
    case 'federation':  return orgs.value.find((o) => o.id === bookId.value)?.name || fromRows
    case 'club':        return clubs.value.find((c) => c.id === bookId.value)?.name || fromRows
    case 'region':      return regions.value.regions.find((r) => r.id === bookId.value)?.name || fromRows
    default:            return fromRows
  }
})

// Every row in a book shares one official flag (it's a property of the
// club / region / country, not the mark), so one banner says it.
const unofficial = computed(() => rows.value.length > 0 && rows.value[0].official === false)

// ---- filtering, all client side (a book tops out around a thousand
// rows per gender, well within what a phone sorts instantly) ----------

// Rows an old migration couldn't give a gender stay out of both books.
const genderRows = computed(() => rows.value.filter((r) => r.gender === gender.value))
const heightsPresent = computed(() => HEIGHTS.filter((h) => genderRows.value.some((r) => r.height === h)))
const needle = computed(() => q.value.replace(/\s+/g, '').toUpperCase())

function byDive(a, b) {
  return a.dive_code.localeCompare(b.dive_code, undefined, { numeric: true })
    || String(a.position).localeCompare(String(b.position))
}

const groups = computed(() => {
  const visible = genderRows.value.filter((r) =>
    (!height.value || r.height === height.value)
    && (!needle.value || `${r.dive_code}${r.position}`.toUpperCase().startsWith(needle.value)))
  return HEIGHTS
    .map((h) => ({ height: h, rows: visible.filter((r) => r.height === h).sort(byDive) }))
    .filter((g) => g.rows.length)
})

function describe(r) {
  const dd = r.dd != null ? `DD ${Number(r.dd).toFixed(1)}` : ''
  return [diveDescription(r), dd].filter(Boolean).join(' · ')
}

// ---- navigation ---------------------------------------------------------

// Rewrite the URL with `patch` laid over the current state. null clears.
function navigate(patch) {
  const next = {
    scope: scope.value, id: bookId.value, org: orgId.value,
    height: height.value, q: q.value, gender: gender.value,
    ...patch,
  }
  const path = next.scope
    ? `/records/${next.scope}${next.id ? `/${next.id}` : ''}`
    : '/records'
  const query = {}
  if (next.org) query.org = next.org
  if (next.height) query.height = next.height
  if (next.q) query.q = next.q
  // Women's is the default book, so only Men's needs saying.
  if (next.gender === 'Male') query.gender = 'Male'
  return router.replace({ path, query })
}

function idForScope(key, forOrg) {
  const o = orgs.value.find((x) => x.id === forOrg)
  if (key === 'federation') return forOrg || null
  if (key === 'continental') return o?.continent || (scope.value === 'continental' ? bookId.value : null)
  return null
}

function selectTab(key) {
  if (key === scope.value) return
  navigate({ scope: key, id: idForScope(key, orgId.value) })
}

function onCountry(value) {
  const next = UUID_RE.test(value) ? value : null
  const key = scope.value || 'federation'
  navigate({ org: next, scope: key, id: idForScope(key, next) })
}

function clearFilters() {
  navigate({ height: null, q: null })
}

// ---- loading ------------------------------------------------------------

async function loadOrgs() {
  try {
    orgs.value = await auth.apiFetch('/api/orgs/active')
  } catch {
    orgs.value = []
  }
}

let orgSeq = 0
async function loadOrgBooks(id) {
  const seq = ++orgSeq
  clubs.value = []
  clubsLoaded.value = false
  regions.value = { label: null, regions: [] }
  if (!id) return
  const [c, r] = await Promise.all([
    auth.apiFetch(`/api/orgs/${id}/clubs`).catch(() => []),
    auth.apiFetch(`/api/orgs/${id}/regions`).catch(() => ({ label: null, regions: [] })),
  ])
  if (seq !== orgSeq) return
  clubs.value = Array.isArray(c) ? c : []
  regions.value = r?.regions ? r : { label: null, regions: [] }
  clubsLoaded.value = true
}

let recordsSeq = 0
async function loadRecords() {
  const seq = ++recordsSeq
  error.value = false
  if (!bookReady.value) {
    rows.value = []
    loading.value = false
    return
  }
  loading.value = true
  try {
    const params = new URLSearchParams({ scope: scope.value, scope_id: bookId.value })
    const body = await auth.apiFetch(`/api/records?${params}`)
    if (seq !== recordsSeq) return
    rows.value = Array.isArray(body) ? body : []
  } catch {
    if (seq !== recordsSeq) return
    rows.value = []
    error.value = true
  } finally {
    if (seq === recordsSeq) loading.value = false
  }
}

watch([scope, bookId], loadRecords, { immediate: true })
watch(orgId, loadOrgBooks, { immediate: true })

// A country with a single club (or region) has nothing to choose, so
// open that book rather than making somebody pick from a list of one.
watch([clubs, () => regions.value.regions, scope, bookId], () => {
  if (bookId.value) return
  const only = scope.value === 'club' ? clubs.value : scope.value === 'region' ? regions.value.regions : []
  if (only.length === 1) navigate({ id: only[0].id })
})

// Per-browser convenience only: which book to open next time.
watch([scope, bookId, orgId], () => {
  if (!bookReady.value) return
  try {
    localStorage.setItem(LAST_BOOK_KEY, JSON.stringify({ scope: scope.value, id: bookId.value, org: orgId.value }))
  } catch { /* private window or blocked storage, no harm done */ }
})

function rememberedBook() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_BOOK_KEY) || 'null')
    if (!saved || !SCOPES.includes(saved.scope)) return null
    const idOk = saved.scope === 'continental' ? CONTINENTS.includes(saved.id) : UUID_RE.test(String(saved.id))
    if (!idOk) return null
    return { scope: saved.scope, id: saved.id, org: UUID_RE.test(String(saved.org)) ? saved.org : null }
  } catch {
    return null
  }
}

// Somebody signed in starts on their own national book. A club admin in
// a country nobody has claimed yet has no national body to speak of, so
// their club's book is the more useful start.
function signedInDefault() {
  const mine = orgs.value.find((o) => o.id === auth.user?.org_id)
  if (!mine) return null
  const club = auth.clubAdminOf[0]
  if (club && mine.claim_state === 'unclaimed') return { scope: 'club', id: club.id, org: mine.id }
  return { scope: 'federation', id: mine.id, org: mine.id }
}

onMounted(async () => {
  await loadOrgs()
  if (route.params.scope) return
  const start = rememberedBook() || signedInDefault()
  if (start) navigate(start)
})
</script>

<template>
  <div class="records-page">
    <!-- Signed-in viewers get this inside the app shell; everyone else
         gets a slim bar with a way home and a way in. -->
    <div v-if="!auth.isLoggedIn" class="records-public-bar">
      <RouterLink to="/" class="records-brand">
        <LogoMark :size="24" />
        <span>DivingHQ</span>
      </RouterLink>
      <RouterLink to="/login" class="btn btn-ghost btn-sm">{{ $t('auth.register.sign_in_link') }}</RouterLink>
    </div>

    <div class="records-wrap">
      <header class="records-head">
        <h1 class="records-title">{{ $t('records.title') }}</h1>
        <p class="records-intro">{{ $t('records.intro') }}</p>
      </header>

      <div class="records-pickers">
        <label class="records-field">
          <span class="label">{{ $t('profile.field_country') }}</span>
          <select class="select" data-testid="records-country" :value="orgId || ''"
                  @change="onCountry($event.target.value)">
            <option value="">{{ $t('regions.pick') }}</option>
            <option v-for="o in orgs" :key="o.id" :value="o.id">{{ orgLabel(o) }}</option>
          </select>
        </label>

        <label v-if="scope === 'region' && regions.regions.length" class="records-field">
          <span class="label">{{ regionLabel }}</span>
          <select class="select" data-testid="records-book-select" :value="bookId || ''"
                  @change="navigate({ id: $event.target.value || null })">
            <option value="">{{ $t('regions.pick') }}</option>
            <option v-for="r in regions.regions" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </label>
        <label v-else-if="scope === 'club' && clubs.length" class="records-field">
          <span class="label">{{ $t('profile.field_club') }}</span>
          <select class="select" data-testid="records-book-select" :value="bookId || ''"
                  @change="navigate({ id: $event.target.value || null })">
            <option value="">{{ $t('regions.pick') }}</option>
            <option v-for="c in clubs" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label v-else-if="scope === 'continental'" class="records-field">
          <span class="label">{{ $t('records.book_continental') }}</span>
          <select class="select" data-testid="records-book-select" :value="bookId || ''"
                  @change="navigate({ id: $event.target.value || null })">
            <option value="">{{ $t('regions.pick') }}</option>
            <option v-for="c in CONTINENTS" :key="c" :value="c">{{ continentName(c) }}</option>
          </select>
        </label>
      </div>

      <div class="records-tabs" role="tablist" :aria-label="$t('records.book_label')">
        <button v-for="tab in tabs" :key="tab.key"
                type="button" role="tab"
                :data-testid="`records-tab-${tab.key}`"
                :aria-selected="scope === tab.key"
                :class="['records-tab', { active: scope === tab.key }]"
                @click="selectTab(tab.key)">{{ tab.label }}</button>
      </div>

      <template v-if="bookReady">
        <div class="records-book-head">
          <h2 class="records-book-name">{{ bookName }}</h2>
          <div class="records-seg" role="group" :aria-label="$t('records.gender_label')">
            <button type="button" data-testid="records-gender-female"
                    :aria-pressed="gender === 'Female'"
                    :class="['records-seg-btn', { active: gender === 'Female' }]"
                    @click="navigate({ gender: 'Female', height: null })">{{ $t('records.women') }}</button>
            <button type="button" data-testid="records-gender-male"
                    :aria-pressed="gender === 'Male'"
                    :class="['records-seg-btn', { active: gender === 'Male' }]"
                    @click="navigate({ gender: 'Male', height: null })">{{ $t('records.men') }}</button>
          </div>
        </div>

        <div v-if="unofficial" class="card-inset records-unofficial" data-testid="records-unofficial">
          <span class="badge badge-amber">{{ $t('records.unofficial') }}</span>
          <p class="records-unofficial-body">{{ $t('records.unofficial_body', { name: bookName }) }}</p>
          <RouterLink to="/register-org" class="records-claim">{{ $t('records.claim_cta') }}</RouterLink>
        </div>

        <div v-if="genderRows.length" class="records-filters">
          <div class="records-chips" role="group" :aria-label="$t('scoreboard.filter_height')">
            <button type="button" data-testid="records-height-all"
                    :aria-pressed="!height"
                    :class="['records-chip', { active: !height }]"
                    @click="navigate({ height: null })">{{ $t('records.all_heights') }}</button>
            <button v-for="h in heightsPresent" :key="h" type="button"
                    :data-testid="`records-height-${h}`"
                    :aria-pressed="height === h"
                    :class="['records-chip', { active: height === h }]"
                    @click="navigate({ height: h })">{{ h }}</button>
          </div>
          <input class="input records-search" type="search" data-testid="records-search"
                 :value="q" :placeholder="$t('records.search')" :aria-label="$t('records.search')"
                 autocomplete="off" spellcheck="false"
                 @input="navigate({ q: $event.target.value || null })">
        </div>
      </template>

      <EmptyState
        v-if="!bookReady && scope === 'club' && orgId && clubsLoaded && !clubs.length"
        icon="🏊"
        :title="$t('my_region.no_clubs_title')"
      />
      <EmptyState
        v-else-if="!bookReady"
        icon="🏅"
        :title="$t('records.pick_title')"
        :body="$t('records.pick_body')"
      />
      <p v-else-if="loading" class="records-loading">{{ $t('common.loading') }}</p>
      <EmptyState
        v-else-if="error"
        icon="⚠️"
        :title="$t('common.error_generic')"
        :action-label="$t('records.retry')"
        :on-action="loadRecords"
      />
      <EmptyState
        v-else-if="!genderRows.length"
        icon="🏅"
        :title="$t('records.empty_title')"
        :body="$t('records.empty_body')"
        action-to="/scoreboard"
        :action-label="$t('scoreboard.page_label')"
      />
      <EmptyState
        v-else-if="!groups.length"
        icon="🔍"
        :title="$t('records.no_match')"
        :action-label="$t('records.clear_filters')"
        :on-action="clearFilters"
      />
      <div v-else class="records-table-wrap">
        <table class="data-table records-table" data-testid="records-table">
          <thead>
            <tr>
              <th scope="col">{{ $t('records.col_dive') }}</th>
              <th scope="col" class="records-num">{{ $t('records.col_score') }}</th>
              <th scope="col">{{ $t('records.col_holder') }}</th>
              <th scope="col" class="records-wide">{{ $t('records.col_set_at') }}</th>
              <th scope="col" class="records-wide">{{ $t('payments.col_date') }}</th>
            </tr>
          </thead>
          <!-- One body per board height, headed like a printed record book. -->
          <tbody v-for="g in groups" :key="g.height">
            <tr class="records-group">
              <th colspan="5" scope="colgroup">{{ g.height }}</th>
            </tr>
            <tr v-for="r in g.rows" :key="r.id" data-testid="records-row">
              <td>
                <span class="records-code">{{ r.dive_code }}{{ r.position }}</span>
                <span v-if="describe(r)" class="records-desc">{{ describe(r) }}</span>
              </td>
              <td class="records-num records-points">{{ Number(r.score).toFixed(2) }}</td>
              <td>
                <RouterLink v-if="r.holder_id && !r.holder_deleted" :to="`/profile/${r.holder_id}`">{{ r.holder_name }}</RouterLink>
                <template v-else>{{ r.holder_name || '—' }}</template>
                <span v-if="scope === 'continental' && r.holder_country_code"
                      class="badge badge-muted records-cc">{{ r.holder_country_code }}</span>
                <!-- Phones drop the last two columns, so the meet and date
                     ride along under the holder instead. -->
                <span class="records-narrow records-desc">
                  <template v-if="r.event_name">{{ r.event_name }} · </template>{{ fmtDate(r.set_at) }}
                </span>
              </td>
              <td class="records-wide">
                <RouterLink v-if="r.event_id" :to="`/scoreboard/${r.event_id}`">{{ r.event_name }}</RouterLink>
                <template v-else>—</template>
              </td>
              <td class="records-wide records-date">{{ fmtDate(r.set_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.records-page { min-height: 100%; background: var(--bg); }

.records-public-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-4); padding: var(--space-3) var(--space-6);
  border-block-end: 1px solid var(--border); background: var(--surface);
}
.records-brand {
  display: inline-flex; align-items: center; gap: var(--space-2);
  font-weight: 700; color: var(--fg); text-decoration: none;
}

.records-wrap {
  max-width: 1000px; margin: 0 auto;
  padding: var(--space-6) var(--space-6) var(--space-8);
  display: flex; flex-direction: column; gap: var(--space-4);
}
.records-title { font-size: var(--text-h2); font-weight: 600; color: var(--fg); margin: 0; }
.records-intro { margin: var(--space-1) 0 0; color: var(--fg-3); font-size: var(--text-sm); max-width: 60ch; }

.records-pickers { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end; }
.records-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 220px; flex: 0 1 320px; }

.records-tabs {
  display: inline-flex; flex-wrap: wrap; gap: var(--space-1); padding: var(--space-1);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);
  align-self: flex-start; max-width: 100%;
}
.records-tab, .records-seg-btn {
  font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 600;
  color: var(--fg-2); background: none; border: none; cursor: pointer;
  padding: var(--space-2) var(--space-4); border-radius: var(--radius-sm);
}
.records-tab:hover, .records-seg-btn:hover { color: var(--fg); }
.records-tab.active, .records-seg-btn.active { background: var(--accent); color: var(--fg-on-accent); }

.records-book-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: var(--space-3); margin-block-start: var(--space-2);
}
.records-book-name { font-size: var(--text-h3); font-weight: 600; color: var(--fg); margin: 0; }
.records-seg {
  display: inline-flex; gap: var(--space-1); padding: var(--space-1);
  background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius);
}

.records-unofficial { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); }
.records-unofficial-body { margin: 0; color: var(--fg-2); font-size: var(--text-sm); max-width: 70ch; }
.records-claim { font-size: var(--text-sm); font-weight: 600; color: var(--accent); }

.records-filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.records-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.records-chip {
  font-family: var(--font-sans); font-size: var(--text-xs); font-weight: 600;
  color: var(--fg-2); background: var(--surface); cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
}
.records-chip:hover { color: var(--fg); border-color: var(--border-2); }
.records-chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.records-search { flex: 1 1 220px; max-width: 320px; }

.records-loading { color: var(--fg-3); font-size: var(--text-sm); margin: 0; }

.records-table-wrap {
  overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface);
}
.records-table { min-width: 640px; }
.records-narrow { display: none; }
.records-group th {
  background: var(--bg-sunken); color: var(--fg); font-size: var(--text-sm);
  text-transform: none; letter-spacing: 0; padding-block: var(--space-2);
}
.records-code { display: block; font-family: var(--font-mono); font-weight: 600; color: var(--fg); }
.records-desc { display: block; font-size: var(--text-xs); color: var(--fg-3); }
.records-num { text-align: end; }
.records-points { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-weight: 700; }
.records-cc { margin-inline-start: var(--space-2); }
.records-date { white-space: nowrap; color: var(--fg-2); }
.records-table a { color: var(--fg); font-weight: 500; text-decoration: none; }
.records-table a:hover { color: var(--accent); text-decoration: underline; }

@media (max-width: 720px) {
  .records-wrap { padding: var(--space-4); }
  .records-public-bar { padding: var(--space-3) var(--space-4); }
  .records-field { flex-basis: 100%; min-width: 0; }
  .records-search { max-width: none; }
}
@media (max-width: 600px) {
  .records-table { min-width: 0; }
  .records-wide { display: none; }
  .records-narrow { display: block; }
  .records-table th, .records-table td { padding-inline: var(--space-3); }
}
</style>
