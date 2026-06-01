<script setup>
// Judge Analysis — a single landing surface that composes the two
// existing judge-transparency tools:
//
//   • By Event — pick a Completed event and render the per-event
//     "what would the standings be if every judge scored like J"
//     matrix (the JudgeRankingTable component, reused verbatim).
//   • By Judge — search the public judge directory and link each
//     result through to its /judge-profile/:id analytics page
//     (reuses the /api/judges/directory search+list pattern from
//     JudgeDirectoryView).
//
// Public-accessible like the Scoreboard: signed-in users get the
// persistent CRM shell (route has meta.appShell); the public get a
// minimal top chrome with a Home link, mirroring ScoreboardView.
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import JudgeRankingTable from '@/components/JudgeRankingTable.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// 'event' | 'judge' — default to the per-event matrix.
const tab = ref('event')

// ── By Event ──────────────────────────────────────────────────
const events = ref([])
const eventsError = ref('')
const selectedEventId = ref('')

// Only Completed events have a stable, meaningful ranking matrix.
const completedEvents = computed(() =>
  events.value.filter((e) => e.status === 'Completed'),
)

async function loadEvents() {
  eventsError.value = ''
  try {
    // Signed-in users get their org's events (every status) from the
    // authed list. The public can't see that endpoint, so they fall
    // back to the open archive — every federation's Live + Completed
    // events — which is exactly the public transparency surface this
    // page is meant to be. Both shapes carry id / name / status /
    // created_at, so completedEvents filters to Completed either way.
    const list = auth.isLoggedIn
      ? await auth.apiFetch('/api/events')
      : await auth.apiFetch('/api/archive')
    events.value = Array.isArray(list) ? list : []
    // Honour ?event=<id> so a user can be deep-linked to a specific
    // event's analysis. Only preselect if it's actually a Completed
    // event we can render.
    const wanted = route.query.event ? String(route.query.event) : ''
    if (wanted && completedEvents.value.some((e) => String(e.id) === wanted)) {
      selectedEventId.value = wanted
    }
  } catch {
    // Network / server error on whichever list we tried. Don't throw;
    // point the user at the per-event entry from the Scoreboard.
    eventsError.value = 'Could not load the event list. Open a specific '
      + 'event from the Scoreboard and use its Judge Ranking Analysis — '
      + 'that page links back here with the event preselected.'
  }
}

// Reflect the picked event in the URL so the page is shareable.
watch(selectedEventId, (id) => {
  const q = { ...route.query }
  if (id) q.event = id
  else delete q.event
  router.replace({ query: q })
})

// ── By Judge ──────────────────────────────────────────────────
const q = ref('')
const orgId = ref('')
const countryCode = ref('')
const rows = ref([])
const total = ref(0)
const offset = ref(0)
const limit = ref(50)
const loadingJudges = ref(false)
const judgesError = ref('')
const orgs = ref([])

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

async function loadJudges() {
  loadingJudges.value = true
  judgesError.value = ''
  try {
    const body = await auth.apiFetch(`/api/judges/directory${buildQS()}`)
    rows.value = body.rows || []
    total.value = body.total ?? 0
  } catch (err) {
    judgesError.value = err.message || 'Could not load judges'
    rows.value = []
    total.value = 0
  } finally {
    loadingJudges.value = false
  }
}

async function loadOrgs() {
  // The org list route requires a session; anonymous viewers just
  // get the free-text country filter instead.
  if (!auth.isLoggedIn) return
  try {
    orgs.value = await auth.apiFetch('/api/orgs/all')
  } catch { /* dropdown stays empty */ }
}

function applyJudgeFilters() {
  offset.value = 0
  loadJudges()
}
function clearJudgeFilters() {
  q.value = ''
  orgId.value = ''
  countryCode.value = ''
  offset.value = 0
  loadJudges()
}
function nextPage() {
  if (offset.value + limit.value >= total.value) return
  offset.value += limit.value
  loadJudges()
}
function prevPage() {
  offset.value = Math.max(0, offset.value - limit.value)
  loadJudges()
}

const pageInfo = computed(() => {
  if (!total.value) return ''
  const from = offset.value + 1
  const to = Math.min(offset.value + rows.value.length, total.value)
  return `Showing ${from}–${to} of ${total.value}`
})

// Apply org/country filters on change (q has its own Apply button
// so it doesn't fire per-keystroke).
watch([orgId, countryCode], () => {
  offset.value = 0
  loadJudges()
})

onMounted(() => {
  loadEvents()
  loadOrgs()
  loadJudges()
})
</script>

<template>
  <div class="ja-page">
    <!-- Public top chrome — only the logged-out spectator sees a
         page title + Home link; signed-in users get this inside the
         CRM shell (sidebar + breadcrumb already provide context). -->
    <div v-if="!auth.isLoggedIn" class="ja-public-bar">
      <span class="ja-public-title">Judge Analysis</span>
      <RouterLink to="/" class="btn btn-ghost btn-sm">Home</RouterLink>
    </div>

    <div class="ja-wrap">
      <div class="ja-head">
        <h1 class="ja-title">Judge Analysis</h1>
        <p class="ja-sub">
          Transparent judging insight — see how a panel ranked one
          event, or how a single judge's calls track across every
          meet they've sat.
        </p>
      </div>

      <!-- Tab switcher -->
      <div class="ja-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'event'"
          :class="['ja-tab', { active: tab === 'event' }]"
          @click="tab = 'event'"
        >By Event</button>
        <button
          type="button"
          role="tab"
          :aria-selected="tab === 'judge'"
          :class="['ja-tab', { active: tab === 'judge' }]"
          @click="tab = 'judge'"
        >By Judge</button>
      </div>

      <!-- ── By Event ── -->
      <section v-if="tab === 'event'" class="ja-panel">
        <div class="ja-controls">
          <label class="field ja-field">
            <span class="ja-field-label">Completed event</span>
            <select class="select" v-model="selectedEventId">
              <option value="">— Select an event —</option>
              <option v-for="e in completedEvents" :key="e.id" :value="String(e.id)">
                {{ e.name }}<template v-if="e.org_name"> · {{ e.org_name }}</template><template v-if="e.created_at"> · {{ new Date(e.created_at).getFullYear() }}</template>
              </option>
            </select>
          </label>
        </div>

        <p v-if="eventsError" class="ja-hint">{{ eventsError }}</p>

        <JudgeRankingTable v-if="selectedEventId" :event-id="selectedEventId" />

        <div v-else-if="!eventsError" class="ja-empty">
          Pick a completed event above to see the per-judge ranking
          matrix — each column shows where every diver, pair, or team
          would have placed under that judge's scores alone.
        </div>
      </section>

      <!-- ── By Judge ── -->
      <section v-else class="ja-panel">
        <div class="ja-controls">
          <label class="field ja-field">
            <span class="ja-field-label">Search</span>
            <input class="input" type="search" v-model="q"
                   placeholder="Judge name…" @keydown.enter="applyJudgeFilters">
          </label>
          <label v-if="orgs.length" class="field ja-field">
            <span class="ja-field-label">Federation</span>
            <select class="select" v-model="orgId">
              <option value="">— Any —</option>
              <option v-for="o in orgs" :key="o.id" :value="o.id">
                {{ o.name }}<template v-if="o.country_code"> ({{ o.country_code }})</template>
              </option>
            </select>
          </label>
          <label class="field ja-field ja-field-cc">
            <span class="ja-field-label">Country</span>
            <input class="input" type="text" maxlength="3" v-model="countryCode"
                   placeholder="AUS" style="text-transform: uppercase">
          </label>
          <button class="btn btn-primary btn-sm" @click="applyJudgeFilters">Apply</button>
          <button v-if="q || orgId || countryCode"
                  class="btn btn-ghost btn-sm" @click="clearJudgeFilters">Clear</button>
        </div>

        <p v-if="judgesError" class="ja-hint">{{ judgesError }}</p>

        <div v-if="loadingJudges && !rows.length" class="ja-empty">Loading…</div>
        <div v-else-if="!rows.length" class="ja-empty">No judges match those filters.</div>

        <table v-else class="ja-judges-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Federation</th>
              <th>Country</th>
              <th>Club</th>
              <th>Scores</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="j in rows" :key="j.id">
              <td class="ja-strong">{{ j.full_name }}</td>
              <td>{{ j.org_name }}</td>
              <td class="ja-mono ja-dim">{{ j.country_code || '—' }}</td>
              <td>
                <template v-if="j.club_name">{{ j.club_name }}</template>
                <span v-else class="ja-dim">—</span>
              </td>
              <td class="ja-mono">{{ j.total_scores }}</td>
              <td>
                <RouterLink :to="`/judge-profile/${j.id}`" class="btn btn-ghost btn-sm">
                  Open analysis →
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="total > rows.length" class="ja-pager">
          <button class="btn btn-ghost btn-sm" :disabled="offset === 0" @click="prevPage">← Prev</button>
          <span class="ja-pager-info">{{ pageInfo }}</span>
          <button class="btn btn-ghost btn-sm"
                  :disabled="offset + rows.length >= total"
                  @click="nextPage">Next →</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ja-page { min-height: 100%; background: var(--bg); }

/* Public top chrome — mirrors ScoreboardView's logged-out header. */
.ja-public-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 0.9rem 1.5rem;
  border-bottom: 1px solid var(--border); background: var(--surface);
}
.ja-public-title {
  font-size: 15px; font-weight: 700; color: var(--text); letter-spacing: -0.01em;
}

.ja-wrap { max-width: 1100px; margin: 0 auto; padding: 1.75rem 1.5rem 2.5rem; }

.ja-head { margin-bottom: 1.25rem; }
.ja-title {
  font-size: 22px; font-weight: 700; color: var(--text);
  letter-spacing: -0.015em; line-height: 1.25;
}
.ja-sub {
  margin-top: 0.4rem; font-size: 13px; color: var(--text-3);
  line-height: 1.5; max-width: 68ch;
}

/* Segmented tab control — token-based, reads in both themes. */
.ja-tabs {
  display: inline-flex; gap: 0.25rem; padding: 0.25rem;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius); margin-bottom: 1.25rem;
}
.ja-tab {
  font-family: var(--font-sans); font-size: 13px; font-weight: 600;
  color: var(--text-2); background: none; border: none; cursor: pointer;
  padding: 0.45rem 1rem; border-radius: var(--radius-sm);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.ja-tab:hover { color: var(--text); }
.ja-tab.active { background: var(--accent); color: var(--fg-on-accent); }

.ja-panel { display: flex; flex-direction: column; gap: 1rem; }

.ja-controls {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem;
}
.ja-field { gap: 0.3rem; min-width: 220px; }
.ja-field-cc { min-width: 110px; max-width: 130px; }
.ja-field-label {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--text-3);
}

.ja-hint {
  font-size: 12.5px; color: var(--text-2); line-height: 1.5;
  background: var(--accent-soft); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.75rem 0.9rem; max-width: 70ch;
}

.ja-empty {
  color: var(--text-3); font-size: 13px; line-height: 1.5;
  padding: 2.25rem 1rem; text-align: center;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius); max-width: 70ch;
}

/* Judges list — mirrors JudgeDirectoryView's table, token-based. */
.ja-judges-table {
  width: 100%; border-collapse: collapse;
  font-size: 13px; background: var(--bg-2);
  border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
}
.ja-judges-table th {
  text-align: start; padding: 0.65rem 0.85rem;
  font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--text-3);
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.ja-judges-table td {
  padding: 0.6rem 0.85rem; border-bottom: 1px solid var(--border);
  color: var(--text-2);
}
.ja-judges-table tr:last-child td { border-bottom: none; }
.ja-strong { color: var(--text); font-weight: 700; }
.ja-dim { color: var(--text-3); }
.ja-mono { font-family: var(--font-mono); }

.ja-pager {
  display: flex; align-items: center; justify-content: center; gap: 1rem;
}
.ja-pager-info { font-size: 11px; color: var(--text-3); }

@media (max-width: 640px) {
  .ja-field, .ja-field-cc { min-width: 0; flex: 1 1 100%; max-width: none; }
}
</style>
