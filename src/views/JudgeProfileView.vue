<script setup>
// Judge Analysis dashboard, a self-service "how am I tracking" view
// for the judge persona. Mirrors the DiverProfileView widget pattern
// (catalog + drag-to-reorder + per-user persistence), but the metrics
// here are WA-judging-programme analytics: deviation from the
// panel-kept mean, drop rate, per-(country/club/height/group/DD)
// breakdowns. The numeric reference for every metric is the post-trim
// panel kept-mean, the same kept set the dive-points formula uses, so
// deviation from it is the same signal a WA assessor would compute by
// hand.
//
// Permission model lives server-side: judges see their own; org
// admins, meet managers and referees in the same org see any judge in
// their org; sysadmins see all. The view drops owner-only affordances
// (Customise, Save layout) for non-owner viewers.
//
// References (PART FOUR of the World Aquatics Competition Regulations):
//   * 7.9   - Awards and scoring of dives by Judges
//   * 8.4.9 - Referee may remove a Judge whose judgement is
//             unsatisfactory; report to Jury of Appeal. Self-
//             service deviation analytics give a judge their
//             own evidence trail before that point.
//   * 10    - General criteria for judging dives.
//   * 13    - Trim rules + dive-points formula (drop high+low,
//             multiply kept sum × DD × scaling).

import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'

const route = useRoute()
const auth = useAuthStore()
const { t } = useI18n()

const profile = ref(null)
const analytics = ref(null)
const loading = ref(false)
const analyticsLoading = ref(false)
const error = ref('')

// =============================================================
// Widget catalog: each widget is { id, label, desc }. Adding one
// here also means adding it to KNOWN_WIDGETS in
// routes/judge-analytics.js (see AGENTS.md "When you change X also
// check Y" table). Heads up, it's easy to forget the other side.
// =============================================================
const JUDGE_WIDGET_CATALOG = [
  { id: 'bias_summary',           label: 'Bias Summary',
    desc: 'Headline mean signed deviation, mean absolute deviation, and stddev vs the panel-kept mean.' },
  { id: 'deviation_distribution', label: 'Deviation Distribution',
    desc: 'Histogram of how often you score above or below the panel kept-mean by 0.5-point bands.' },
  { id: 'agreement_rate',         label: 'Agreement Rate',
    desc: 'Percentage of your scores within ±0.5 (one increment) and ±1.0 of the panel kept-mean.' },
  { id: 'drop_rate',              label: 'Drop Rate',
    desc: 'How often your score gets trimmed off the panel — with the high vs low split.' },
  { id: 'height_breakdown',       label: 'By Board Height',
    desc: 'Mean signed deviation broken out by 1m / 3m / 5m / 7.5m / 10m.' },
  { id: 'group_breakdown',        label: 'By Dive Group',
    desc: 'Mean signed deviation by dive group (forward, back, reverse, inward, twisting, armstand).' },
  { id: 'country_breakdown',      label: 'By Diver Country',
    desc: 'Per-country bias signal — the per-country mean signed deviation.' },
  { id: 'club_breakdown',         label: 'By Diver Club',
    desc: 'Per-club bias signal — same as country, narrower.' },
  { id: 'diver_breakdown',        label: 'By Individual Diver',
    desc: 'Top divers you have scored by absolute deviation; can flag per-diver bias.' },
  { id: 'round_breakdown',        label: 'By Round',
    desc: 'Mean signed deviation per round — do you tighten up or drift in later rounds?' },
  { id: 'dd_breakdown',           label: 'By DD Difficulty',
    desc: 'Easy (<2.0), medium, hard, very hard — do you score harder dives differently?' },
  { id: 'recent_meets',           label: 'Recent Meets',
    desc: 'Last 10 meets officiated with mean deviation, dive count, and drop rate.' },
  { id: 'score_trend',            label: 'Trend Over Time',
    desc: 'Weekly mean signed deviation — are you drifting or holding steady?' },
  { id: 'panel_compare',          label: 'Panel Comparison',
    desc: 'Your average score vs the average panel-kept mean across all comparable dives.' },
  { id: 'panel_deviation',        label: 'Panel Deviation',
    desc: 'How often your scores differ from the rest of the panel — per dive and per event. Two cohorts: dropped outliers (your score fell outside the kept-trim slice) and substantive disagreements (≥1.0 from the panel kept-mean).' },
]

// =============================================================
// State for customise modal + persistence
// =============================================================
const customizing = ref(false)
// Lock background scroll while the dashboard-customize modal is open.
useBodyScrollLock().lockWhile(customizing)
const customizeSaving = ref(false)
const customizeErr = ref('')
const dragIndex = ref(null)
const dragOverIndex = ref(null)

// Date range filter. Empty strings mean no filter on that side.
const fromDate = ref('')
const toDate = ref('')

const targetId = computed(() => route.params.id || auth.user?.id)
const isSelf = computed(() => targetId.value && targetId.value === auth.user?.id)

const enabledWidgets = computed(() =>
  Array.isArray(profile.value?.dashboard_widgets)
    ? profile.value.dashboard_widgets
    : ['bias_summary', 'deviation_distribution', 'height_breakdown', 'recent_meets'],
)
const orderedEnabled = computed(() => {
  const known = new Set(JUDGE_WIDGET_CATALOG.map(w => w.id))
  return enabledWidgets.value.filter(id => known.has(id))
})
function isEnabled(id) { return enabledWidgets.value.includes(id) }
function widgetOrder(id) {
  const idx = orderedEnabled.value.indexOf(id)
  return idx === -1 ? 999 : idx
}

const customizeList = computed(() => {
  const enabledSet = new Set(enabledWidgets.value)
  const enabledOrdered = enabledWidgets.value
    .filter(id => enabledSet.has(id))
    .map(id => JUDGE_WIDGET_CATALOG.find(w => w.id === id))
    .filter(Boolean)
  const disabled = JUDGE_WIDGET_CATALOG.filter(w => !enabledSet.has(w.id))
  return [...enabledOrdered, ...disabled]
})

async function saveWidgets(next) {
  customizeSaving.value = true
  customizeErr.value = ''
  try {
    const r = await auth.apiFetch('/api/users/me/judge-dashboard', {
      method: 'PUT',
      body: JSON.stringify({ widgets: next }),
    })
    profile.value.dashboard_widgets = r.widgets
  } catch (err) {
    customizeErr.value = err.message || 'Save failed'
  } finally {
    customizeSaving.value = false
  }
}
async function toggleWidget(id) {
  if (!isSelf.value) return
  const next = isEnabled(id)
    ? enabledWidgets.value.filter(w => w !== id)
    : [...enabledWidgets.value, id]
  await saveWidgets(next)
}

function onDragStart(idx, ev) {
  dragIndex.value = idx
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    try { ev.dataTransfer.setData('text/plain', String(idx)) } catch { /* ignore */ }
  }
}
function onDragOver(idx, ev) {
  if (dragIndex.value == null) return
  ev.preventDefault()
  dragOverIndex.value = idx
}
function onDragLeave(idx) {
  if (dragOverIndex.value === idx) dragOverIndex.value = null
}
async function onDrop(idx, ev) {
  ev.preventDefault()
  const from = dragIndex.value
  dragIndex.value = null
  dragOverIndex.value = null
  if (from == null || from === idx) return
  const list = customizeList.value.slice()
  const [moved] = list.splice(from, 1)
  list.splice(idx, 0, moved)
  const enabledSet = new Set(enabledWidgets.value)
  const next = list.map(w => w.id).filter(id => enabledSet.has(id))
  await saveWidgets(next)
}
function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

function dateQS() {
  const parts = []
  if (fromDate.value) parts.push(`from_date=${encodeURIComponent(fromDate.value)}`)
  if (toDate.value)   parts.push(`to_date=${encodeURIComponent(toDate.value)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

async function load() {
  if (!targetId.value) {
    error.value = 'Sign in to see your judge analysis.'
    return
  }
  loading.value = true
  error.value = ''
  try {
    profile.value = await auth.apiFetch(
      `/api/judges/${targetId.value}/profile${dateQS()}`,
    )
  } catch (err) {
    error.value = err.message || 'Could not load judge profile'
    profile.value = null
  } finally {
    loading.value = false
  }
  // Analytics fires in parallel, heavy aggregations don't block the
  // header render.
  analyticsLoading.value = true
  try {
    analytics.value = await auth.apiFetch(
      `/api/judges/${targetId.value}/analytics${dateQS()}`,
    )
  } catch (err) {
    // Analytics failure isn't fatal, the header still renders.
    console.error('[JudgeProfile] analytics failed', err)
    analytics.value = null
  } finally {
    analyticsLoading.value = false
  }
}

async function applyDateFilter() {
  await load()
}
function clearDateFilter() {
  fromDate.value = ''
  toDate.value = ''
  load()
}

// =============================================================
// Display helpers
// =============================================================

function fmtNum(n, digits = 2) {
  if (n == null) return '—'
  const v = Number(n)
  if (Number.isNaN(v)) return '—'
  return v.toFixed(digits)
}
function fmtSigned(n, digits = 2) {
  if (n == null) return '—'
  const v = Number(n)
  if (Number.isNaN(v)) return '—'
  const sign = v > 0 ? '+' : (v < 0 ? '' : ' ')
  return `${sign}${v.toFixed(digits)}`
}
function fmtPct(rate, digits = 1) {
  if (rate == null) return '—'
  const v = Number(rate)
  if (Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}
function biasClass(n) {
  if (n == null) return ''
  const v = Number(n)
  if (Math.abs(v) < 0.05) return 'bias-neutral'
  if (Math.abs(v) < 0.30) return 'bias-mild'
  return v > 0 ? 'bias-high' : 'bias-low'
}

// Bar width helper: normalises a value against the the maximum |signed|
// in the same array so a horizontal bar visualises bias intensity.
function deviationBarWidth(value, rows, key = 'signed_deviation') {
  if (value == null || !rows?.length) return 0
  const maxAbs = Math.max(0.1, ...rows.map(r => Math.abs(Number(r[key]) || 0)))
  return Math.min(100, (Math.abs(Number(value)) / maxAbs) * 100)
}
function comparePeerBarWidth(value, a, b) {
  if (value == null) return 0
  const pair = [Number(a) || 0, Number(b) || 0]
  const max = Math.max(0.1, ...pair)
  return Math.min(100, (Number(value) / max) * 100)
}

// Map dive_group digit (1..6) → human-friendly label.
function groupLabel(digit) {
  switch (String(digit)) {
    case '1': return 'Forward'
    case '2': return 'Back'
    case '3': return 'Reverse'
    case '4': return 'Inward'
    case '5': return 'Twisting'
    case '6': return 'Armstand'
    default:  return digit ? `Group ${digit}` : '—'
  }
}

// Insight text for the bias_summary widget: a short plain-English
// summary so a judge new to the page understands the headline.
const biasInsight = computed(() => {
  const s = analytics.value?.bias_summary
  if (!s) return ''
  const v = Number(s.mean_signed_deviation)
  if (!s.sample_size) return 'Not enough comparable dives yet to compute a deviation.'
  if (Number.isNaN(v)) return ''
  const dir = v > 0 ? 'higher' : (v < 0 ? 'lower' : 'in line with')
  const mag = Math.abs(v)
  if (mag < 0.05) {
    return `Across ${s.sample_size} comparable dives you score in line with the panel-kept mean.`
  }
  return `Across ${s.sample_size} comparable dives you score on average ${mag.toFixed(2)} ${dir} than the panel-kept mean.`
})

// Print / "save as PDF" button. Relies on the browser's print dialog
// and our @media print stylesheet.
function exportPDF() {
  document.body.classList.add('printing-dashboard')
  const cleanup = () => {
    document.body.classList.remove('printing-dashboard')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  requestAnimationFrame(() => window.print())
}

onMounted(load)
watch(() => route.params.id, () => { load() })
</script>

<template>
  <div class="profile-wrap judge-profile">
    <!-- Header -->
    <div class="page-header">
      <div>
        <div class="page-label">Judge Analysis</div>
        <h1 class="page-title">
          {{ profile?.judge?.full_name || (loading ? 'Loading…' : '—') }}
        </h1>
        <div v-if="profile?.judge" class="page-sub">
          <span v-if="profile.judge.org_name" class="page-sub-club">
            {{ profile.judge.org_name }}<template v-if="profile.judge.country_code"> · {{ profile.judge.country_code }}</template>
          </span>
          <template v-if="profile.judge.club_name">
            · {{ profile.judge.club_name }}
            <span v-if="profile.judge.club_code" class="club-code">{{ profile.judge.club_code }}</span>
          </template>
        </div>
      </div>
      <div class="header-actions">
        <RouterLink to="/judges" class="btn btn-ghost btn-sm">← All judges</RouterLink>
        <RouterLink v-if="auth.isLoggedIn" to="/dashboard" class="btn btn-ghost btn-sm">Dashboard</RouterLink>
        <button v-if="isSelf" class="btn btn-ghost btn-sm" @click="customizing = true">
          ⚙ Customise
        </button>
        <button class="btn btn-ghost btn-sm" @click="exportPDF">📄 Print / PDF</button>
      </div>
    </div>

    <!-- Date range filter -->
    <div class="date-filter-bar">
      <div class="date-filter-fields">
        <label class="date-field">
          <span class="date-field-label">From</span>
          <input class="input" type="date" v-model="fromDate">
        </label>
        <label class="date-field">
          <span class="date-field-label">To</span>
          <input class="input" type="date" v-model="toDate">
        </label>
        <button class="btn btn-primary btn-sm" @click="applyDateFilter">Apply</button>
        <button v-if="fromDate || toDate" class="btn btn-ghost btn-sm" @click="clearDateFilter">Clear</button>
      </div>
      <p class="date-filter-hint">
        WA Article 13 trim rules apply throughout — the reference is the
        kept mean (post-trim) for each dive, the same kept set the
        dive-points formula uses.
      </p>
    </div>

    <div v-if="error" class="msg msg-error" style="margin-bottom: 1rem">{{ error }}</div>

    <!-- Stats strip -->
    <div v-if="profile?.stats" class="stat-strip">
      <div class="stat-cell">
        <div class="stat-num">{{ profile.stats.events_officiated || 0 }}</div>
        <div class="stat-lbl">Events officiated</div>
      </div>
      <div class="stat-cell">
        <div class="stat-num">{{ profile.stats.total_scores || 0 }}</div>
        <div class="stat-lbl">Scores submitted</div>
      </div>
      <div class="stat-cell">
        <div class="stat-num" :class="biasClass(profile.stats.mean_signed_deviation)">
          {{ fmtSigned(profile.stats.mean_signed_deviation, 2) }}
        </div>
        <div class="stat-lbl">Mean signed deviation</div>
      </div>
      <div class="stat-cell">
        <div class="stat-num">{{ fmtNum(profile.stats.mean_abs_deviation, 2) }}</div>
        <div class="stat-lbl">Mean abs deviation</div>
      </div>
      <div class="stat-cell">
        <div class="stat-num">{{ fmtPct(profile.stats.drop_rate) }}</div>
        <div class="stat-lbl">Drop rate</div>
      </div>
    </div>

    <div v-if="!profile && !loading" class="empty">No judge data yet.</div>

    <!-- =============================================================
         Widgets: each card is conditionally rendered based on the
         judge's enabled list, ordered via :style="{ order: … }".
         ============================================================= -->
    <div v-if="profile" class="content widget-grid">

      <!-- bias_summary -->
      <div v-if="isEnabled('bias_summary')" class="card" :style="{ order: widgetOrder('bias_summary') }">
        <div class="card-head">Bias Summary</div>
        <div v-if="!analytics?.bias_summary?.sample_size" class="empty-mini">Not enough comparable dives yet.</div>
        <template v-else>
          <div class="bias-grid">
            <div class="bias-cell">
              <div class="bias-num" :class="biasClass(analytics.bias_summary.mean_signed_deviation)">
                {{ fmtSigned(analytics.bias_summary.mean_signed_deviation, 2) }}
              </div>
              <div class="bias-lbl">Signed deviation</div>
            </div>
            <div class="bias-cell">
              <div class="bias-num">{{ fmtNum(analytics.bias_summary.mean_abs_deviation, 2) }}</div>
              <div class="bias-lbl">Abs deviation</div>
            </div>
            <div class="bias-cell">
              <div class="bias-num">{{ fmtNum(analytics.bias_summary.stddev_deviation, 2) }}</div>
              <div class="bias-lbl">Stddev</div>
            </div>
            <div class="bias-cell">
              <div class="bias-num">{{ analytics.bias_summary.sample_size }}</div>
              <div class="bias-lbl">Sample size</div>
            </div>
          </div>
          <p class="widget-hint">{{ biasInsight }}</p>
        </template>
      </div>

      <!-- deviation_distribution -->
      <div v-if="isEnabled('deviation_distribution')" class="card"
           :style="{ order: widgetOrder('deviation_distribution') }">
        <div class="card-head">Deviation Distribution</div>
        <div v-if="!analytics?.deviation_distribution?.length" class="empty-mini">No comparable dives yet.</div>
        <div v-else class="bar-list">
          <div v-for="b in analytics.deviation_distribution" :key="b.bucket" class="bar-row">
            <span class="bar-label">{{ b.bucket }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['hist-fill', b.bucket.startsWith('-') ? 'low' : (b.bucket === '0.0' ? 'neutral' : 'high')]"
                   :style="{
                     width: deviationBarWidth(b.count,
                       analytics.deviation_distribution, 'count') + '%'
                   }"></div>
            </div>
            <span class="bar-value">{{ b.count }}</span>
          </div>
        </div>
      </div>

      <!-- agreement_rate -->
      <div v-if="isEnabled('agreement_rate')" class="card"
           :style="{ order: widgetOrder('agreement_rate') }">
        <div class="card-head">Agreement Rate</div>
        <div v-if="!analytics?.agreement_rate?.total" class="empty-mini">No comparable dives yet.</div>
        <div v-else class="bias-grid">
          <div class="bias-cell">
            <div class="bias-num">{{ fmtPct(analytics.agreement_rate.within_half_rate) }}</div>
            <div class="bias-lbl">Within ±0.5 (one increment)</div>
          </div>
          <div class="bias-cell">
            <div class="bias-num">{{ fmtPct(analytics.agreement_rate.within_one_rate) }}</div>
            <div class="bias-lbl">Within ±1.0</div>
          </div>
          <div class="bias-cell">
            <div class="bias-num">{{ analytics.agreement_rate.within_half }}</div>
            <div class="bias-lbl">Calls within ±0.5</div>
          </div>
          <div class="bias-cell">
            <div class="bias-num">{{ analytics.agreement_rate.total }}</div>
            <div class="bias-lbl">Sample size</div>
          </div>
        </div>
      </div>

      <!-- drop_rate -->
      <div v-if="isEnabled('drop_rate')" class="card" :style="{ order: widgetOrder('drop_rate') }">
        <div class="card-head">Drop Rate</div>
        <div v-if="!analytics?.drop_rate?.sample_size" class="empty-mini">No trimmed dives yet.</div>
        <div v-else class="bias-grid">
          <div class="bias-cell">
            <div class="bias-num">{{ fmtPct(analytics.drop_rate.drop_rate) }}</div>
            <div class="bias-lbl">Trimmed off</div>
          </div>
          <div class="bias-cell">
            <div class="bias-num bias-high">{{ fmtPct(analytics.drop_rate.drop_high_rate) }}</div>
            <div class="bias-lbl">Dropped HIGH</div>
          </div>
          <div class="bias-cell">
            <div class="bias-num bias-low">{{ fmtPct(analytics.drop_rate.drop_low_rate) }}</div>
            <div class="bias-lbl">Dropped LOW</div>
          </div>
          <div class="bias-cell">
            <div class="bias-num">{{ analytics.drop_rate.sample_size }}</div>
            <div class="bias-lbl">Sample size</div>
          </div>
        </div>
      </div>

      <!-- height_breakdown -->
      <div v-if="isEnabled('height_breakdown')" class="card"
           :style="{ order: widgetOrder('height_breakdown') }">
        <div class="card-head">By Board Height</div>
        <div v-if="!analytics?.height_breakdown?.length" class="empty-mini">No height data yet.</div>
        <div v-else class="bar-list">
          <div v-for="h in analytics.height_breakdown" :key="h.height" class="bar-row">
            <span class="bar-label">{{ h.height }}m</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(h.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(h.signed_deviation,
                       analytics.height_breakdown) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(h.signed_deviation)">
              {{ fmtSigned(h.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ h.dives }} dives</span>
          </div>
        </div>
      </div>

      <!-- group_breakdown -->
      <div v-if="isEnabled('group_breakdown')" class="card"
           :style="{ order: widgetOrder('group_breakdown') }">
        <div class="card-head">By Dive Group</div>
        <div v-if="!analytics?.group_breakdown?.length" class="empty-mini">No group data yet.</div>
        <div v-else class="bar-list">
          <div v-for="g in analytics.group_breakdown" :key="g.dive_group" class="bar-row">
            <span class="bar-label">{{ groupLabel(g.dive_group) }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(g.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(g.signed_deviation,
                       analytics.group_breakdown) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(g.signed_deviation)">
              {{ fmtSigned(g.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ g.dives }} dives</span>
          </div>
        </div>
      </div>

      <!-- country_breakdown -->
      <div v-if="isEnabled('country_breakdown')" class="card"
           :style="{ order: widgetOrder('country_breakdown') }">
        <div class="card-head">By Diver Country</div>
        <div v-if="!analytics?.country_breakdown?.length" class="empty-mini">
          Not enough cross-country dives yet.
        </div>
        <div v-else class="bar-list">
          <div v-for="c in analytics.country_breakdown" :key="c.country_code" class="bar-row">
            <span class="bar-label">{{ c.country_code }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(c.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(c.signed_deviation,
                       analytics.country_breakdown) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(c.signed_deviation)">
              {{ fmtSigned(c.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ c.dives }} dives</span>
          </div>
        </div>
        <p class="widget-hint">
          Article 7.4: a Final-stage panel should be drawn from
          judges of a different Sport Nationality to the athletes.
        </p>
      </div>

      <!-- club_breakdown -->
      <div v-if="isEnabled('club_breakdown')" class="card"
           :style="{ order: widgetOrder('club_breakdown') }">
        <div class="card-head">By Diver Club</div>
        <div v-if="!analytics?.club_breakdown?.length" class="empty-mini">
          Not enough cross-club dives yet.
        </div>
        <div v-else class="bar-list">
          <div v-for="c in analytics.club_breakdown" :key="c.club_id" class="bar-row">
            <span class="bar-label">{{ c.club_code || '—' }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(c.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(c.signed_deviation,
                       analytics.club_breakdown) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(c.signed_deviation)">
              {{ fmtSigned(c.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ c.dives }} dives</span>
          </div>
        </div>
      </div>

      <!-- diver_breakdown -->
      <div v-if="isEnabled('diver_breakdown')" class="card"
           :style="{ order: widgetOrder('diver_breakdown') }">
        <div class="card-head">By Individual Diver</div>
        <div v-if="!analytics?.diver_breakdown?.length" class="empty-mini">
          Not enough per-diver dives yet.
        </div>
        <table v-else class="pb-table">
          <thead>
            <tr>
              <th>Diver</th>
              <th>Country</th>
              <th>Dives</th>
              <th>Signed</th>
              <th>Abs</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in analytics.diver_breakdown" :key="d.diver_id">
              <td class="strong">{{ d.diver_name || '—' }}</td>
              <td class="mono dim">{{ d.country_code || '—' }}</td>
              <td class="mono dim">{{ d.dives }}</td>
              <td class="mono" :class="biasClass(d.signed_deviation)">
                {{ fmtSigned(d.signed_deviation, 2) }}
              </td>
              <td class="mono">{{ fmtNum(d.abs_deviation, 2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- round_breakdown -->
      <div v-if="isEnabled('round_breakdown')" class="card"
           :style="{ order: widgetOrder('round_breakdown') }">
        <div class="card-head">By Round</div>
        <div v-if="!analytics?.round_breakdown?.length" class="empty-mini">No rounds yet.</div>
        <div v-else class="bar-list">
          <div v-for="r in analytics.round_breakdown" :key="r.round_number" class="bar-row">
            <span class="bar-label">Round {{ r.round_number }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(r.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(r.signed_deviation,
                       analytics.round_breakdown) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(r.signed_deviation)">
              {{ fmtSigned(r.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ r.dives }} dives</span>
          </div>
        </div>
      </div>

      <!-- dd_breakdown -->
      <div v-if="isEnabled('dd_breakdown')" class="card"
           :style="{ order: widgetOrder('dd_breakdown') }">
        <div class="card-head">By DD Difficulty</div>
        <div v-if="!analytics?.dd_breakdown?.length" class="empty-mini">No DD-tagged dives yet.</div>
        <div v-else class="bar-list">
          <div v-for="d in analytics.dd_breakdown" :key="d.dd_bucket" class="bar-row">
            <span class="bar-label">{{ d.dd_bucket }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(d.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(d.signed_deviation,
                       analytics.dd_breakdown) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(d.signed_deviation)">
              {{ fmtSigned(d.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ d.dives }} dives</span>
          </div>
        </div>
      </div>

      <!-- recent_meets -->
      <div v-if="isEnabled('recent_meets')" class="card"
           :style="{ order: widgetOrder('recent_meets') }">
        <div class="card-head">Recent Meets</div>
        <div v-if="!analytics?.recent_meets?.length" class="empty-mini">No meets yet.</div>
        <table v-else class="pb-table">
          <thead>
            <tr>
              <th>Meet</th>
              <th>Date</th>
              <th>Dives</th>
              <th>Signed</th>
              <th>Drop %</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in analytics.recent_meets" :key="m.event_id">
              <td class="strong">{{ m.event_name }}</td>
              <td class="mono dim">
                {{ m.created_at ? new Date(m.created_at).toISOString().slice(0,10) : '—' }}
              </td>
              <td class="mono dim">{{ m.dives }}</td>
              <td class="mono" :class="biasClass(m.signed_deviation)">
                {{ fmtSigned(m.signed_deviation, 2) }}
              </td>
              <td class="mono">{{ fmtPct(m.drop_rate) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- score_trend -->
      <div v-if="isEnabled('score_trend')" class="card"
           :style="{ order: widgetOrder('score_trend') }">
        <div class="card-head">Trend Over Time</div>
        <div v-if="!analytics?.score_trend?.length" class="empty-mini">Not enough weeks yet.</div>
        <div v-else class="bar-list">
          <div v-for="w in analytics.score_trend" :key="w.week" class="bar-row">
            <span class="bar-label">{{ w.week }}</span>
            <div class="bar-track">
              <div class="bar-fill"
                   :class="['signed-fill', Number(w.signed_deviation) > 0 ? 'high' : 'low']"
                   :style="{
                     width: deviationBarWidth(w.signed_deviation,
                       analytics.score_trend) + '%'
                   }"></div>
            </div>
            <span class="bar-value" :class="biasClass(w.signed_deviation)">
              {{ fmtSigned(w.signed_deviation, 2) }}
            </span>
            <span class="bar-meta">{{ w.dives }} dives</span>
          </div>
        </div>
      </div>

      <!-- panel_compare -->
      <div v-if="isEnabled('panel_compare')" class="card"
           :style="{ order: widgetOrder('panel_compare') }">
        <div class="card-head">Panel Comparison</div>
        <div v-if="!analytics?.panel_compare?.dives" class="empty-mini">No comparable dives yet.</div>
        <div v-else class="compare-grid">
          <div class="compare-row">
            <span class="compare-lbl">Avg score</span>
            <div class="compare-bars">
              <div class="compare-bar compare-me"
                   :style="{ width: comparePeerBarWidth(analytics.panel_compare.my_avg,
                     analytics.panel_compare.my_avg, analytics.panel_compare.panel_avg) + '%' }"></div>
              <div class="compare-bar compare-peer"
                   :style="{ width: comparePeerBarWidth(analytics.panel_compare.panel_avg,
                     analytics.panel_compare.my_avg, analytics.panel_compare.panel_avg) + '%' }"></div>
            </div>
            <span class="compare-vals">
              <span class="compare-me-text">You {{ fmtNum(analytics.panel_compare.my_avg, 2) }}</span>
              <span class="compare-peer-text">Panel {{ fmtNum(analytics.panel_compare.panel_avg, 2) }}</span>
            </span>
          </div>
        </div>
        <p class="widget-hint">
          Sample: {{ analytics.panel_compare.dives }} comparable dives.
          Range you scored: {{ fmtNum(analytics.panel_compare.my_min, 1) }} – {{ fmtNum(analytics.panel_compare.my_max, 1) }}.
        </p>
      </div>

      <!-- Panel Deviation: how often this judge differs from the
           rest of the panel. Headline shows two rates (substantive
           disagreement ≥1.0 from kept-mean, and dropped-outlier:
           score sat outside the kept-trim slice on that dive).
           Per-event table beneath lets the judge see whether one
           specific meet drove the headline. -->
      <div v-if="isEnabled('panel_deviation')" class="card"
           :style="{ order: widgetOrder('panel_deviation') }">
        <div class="card-head">Panel Deviation</div>
        <div v-if="!analytics?.panel_deviation?.summary?.total"
             class="empty-mini">Not enough comparable dives yet.</div>
        <template v-else>
          <div class="bias-grid">
            <div class="bias-cell">
              <div class="bias-num">{{ fmtPct(analytics.panel_deviation.summary.tight_rate) }}</div>
              <div class="bias-lbl">≥1.0 from kept-mean</div>
            </div>
            <div class="bias-cell">
              <div class="bias-num">{{ fmtPct(analytics.panel_deviation.summary.loose_rate) }}</div>
              <div class="bias-lbl">Dropped by trim</div>
            </div>
            <div class="bias-cell">
              <div class="bias-num">{{ analytics.panel_deviation.summary.differ_tight }}</div>
              <div class="bias-lbl">Substantive disagreements</div>
            </div>
            <div class="bias-cell">
              <div class="bias-num">{{ analytics.panel_deviation.summary.total }}</div>
              <div class="bias-lbl">Sample size</div>
            </div>
          </div>
          <table v-if="analytics.panel_deviation.per_event?.length"
                 class="pb-table" style="margin-top: 0.75rem">
            <thead>
              <tr>
                <th>Meet</th>
                <th>Date</th>
                <th>Dives</th>
                <th>≥1.0</th>
                <th>Differ %</th>
                <th>Signed</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in analytics.panel_deviation.per_event" :key="e.event_id">
                <td class="strong">{{ e.event_name }}</td>
                <td class="mono dim">
                  {{ e.created_at ? new Date(e.created_at).toISOString().slice(0,10) : '—' }}
                </td>
                <td class="mono dim">{{ e.dives }}</td>
                <td class="mono">{{ e.differ_tight }}</td>
                <td class="mono">{{ fmtPct(e.tight_rate) }}</td>
                <td class="mono" :class="biasClass(e.signed_deviation)">
                  {{ fmtSigned(e.signed_deviation, 2) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="widget-hint">
            Substantive disagreement = your award ≥1.0 from the
            panel-kept mean. Dropped by trim = your award sat
            outside the kept-trim slice for that dive (panel
            size minus the high/low drops).
          </p>
        </template>
      </div>

    </div><!-- /widget grid -->

    <!-- Customise modal -->
    <div v-if="customizing" class="modal-backdrop" @click.self="customizing = false">
      <div class="modal customize-modal">
        <div class="modal-head">
          <div class="modal-title">Customise Judge Analysis</div>
          <button class="btn btn-ghost btn-sm" @click="customizing = false">Done</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint" style="margin-top:0">
            Toggle widgets on or off. Drag the ⋮⋮ handle to re-order.
            Changes save automatically.
          </p>
          <div class="widget-toggles" @dragend="onDragEnd">
            <div
              v-for="(w, idx) in customizeList"
              :key="w.id"
              :class="['widget-toggle',
                       { 'is-dragging': dragIndex === idx,
                         'is-drop-target': dragOverIndex === idx && dragIndex !== idx,
                         'is-disabled': !isEnabled(w.id) }]"
              :draggable="isSelf"
              @dragstart="onDragStart(idx, $event)"
              @dragover="onDragOver(idx, $event)"
              @dragleave="onDragLeave(idx)"
              @drop="onDrop(idx, $event)"
            >
              <span class="drag-handle" v-tip="isSelf ? 'Drag to re-order' : ''">⋮⋮</span>
              <input type="checkbox"
                     :checked="isEnabled(w.id)"
                     :disabled="customizeSaving || !isSelf"
                     @change="toggleWidget(w.id)">
              <div class="widget-toggle-text">
                <div class="widget-toggle-label">{{ w.label }}</div>
                <div class="widget-toggle-desc">{{ w.desc }}</div>
              </div>
            </div>
          </div>
          <div v-if="customizeErr" class="msg msg-error">{{ customizeErr }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-display); font-size: 40px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; }
.page-sub-club { color: var(--text-2); }
.club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}
.header-actions {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
}

.date-filter-bar {
  display: flex; flex-direction: column; gap: 0.4rem;
  margin-bottom: 1.25rem;
}
.date-filter-fields {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem;
}
.date-field {
  display: flex; flex-direction: column; gap: 0.25rem;
}
.date-field-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
}
.date-filter-hint {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}

.stat-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.stat-cell { text-align: center; }
.stat-num {
  font-family: var(--font-display); font-size: 24px; font-weight: 900;
  color: var(--text); line-height: 1;
}
.stat-lbl {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.4rem;
}
.bias-neutral { color: var(--text); }
.bias-mild    { color: var(--amber, #f59e0b); }
.bias-high    { color: var(--red, #ef4444); }
.bias-low     { color: var(--cyan, #06b6d4); }

.widget-grid {
  display: flex; flex-direction: column; gap: 1.25rem;
}
.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

.card {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem;
}
.card-head {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 0.75rem;
}
.empty-mini {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
}

.bias-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
}
.bias-cell { text-align: center; }
.bias-num {
  font-family: var(--font-display); font-size: 22px; font-weight: 900;
  color: var(--text); line-height: 1;
}
.bias-lbl {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.4rem;
}

.bar-list { display: flex; flex-direction: column; gap: 0.4rem; }
.bar-row {
  display: grid;
  grid-template-columns: 80px 1fr 80px 80px;
  align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px;
}
.bar-label { color: var(--text-2); font-weight: 600; }
.bar-track {
  position: relative; height: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.bar-fill {
  position: absolute; top: 0; bottom: 0; inset-inline-start: 0;
  background: var(--cyan);
}
.signed-fill.high     { background: var(--red, #ef4444); }
.signed-fill.low      { background: var(--cyan, #06b6d4); }
.hist-fill.high       { background: var(--red, #ef4444); }
.hist-fill.low        { background: var(--cyan, #06b6d4); }
.hist-fill.neutral    { background: var(--green, #10b981); }
.bar-value { color: var(--text); font-weight: 700; text-align: end; }
.bar-meta  { color: var(--text-3); font-size: 11px; }

.pb-table {
  width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 12px;
}
.pb-table th {
  text-align: start; padding: 0.4rem 0.5rem;
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  border-bottom: 1px solid var(--border);
}
.pb-table td {
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
}
.pb-table .strong { color: var(--text); font-weight: 700; }
.pb-table .mono { font-family: var(--font-mono); }
.pb-table .dim { color: var(--text-3); }

.compare-grid { display: flex; flex-direction: column; gap: 0.6rem; }
.compare-row {
  display: grid;
  grid-template-columns: 100px 1fr 220px;
  align-items: center; gap: 0.7rem;
}
.compare-lbl {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-2);
}
.compare-bars {
  display: flex; flex-direction: column; gap: 4px;
}
.compare-bar {
  height: 8px; border-radius: var(--radius-sm); min-width: 1px;
}
.compare-me   { background: var(--cyan, #06b6d4); }
.compare-peer { background: var(--text-3); }
.compare-vals {
  display: flex; gap: 1rem; font-family: var(--font-mono); font-size: 11px;
  justify-content: flex-end;
}
.compare-me-text { color: var(--cyan); }
.compare-peer-text { color: var(--text-3); }

.widget-hint {
  margin-top: 0.7rem;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
}

/* =========================================================
   Modal, copied / adapted from DiverProfileView.
   Pattern: backdrop is the scrollable container (NOT the
   modal) so a tall modal scrolls the backdrop instead of
   being clipped behind iOS Safari's URL/toolbar. DOM is
   parent-child:
     <div class="modal-backdrop"> <div class="modal">…</div> </div>
   ========================================================= */
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  z-index: 300;
  display: flex; align-items: center; justify-content: center;
  padding: 1.5rem;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.modal {
  position: relative;
  z-index: 301;
  background: var(--bg-2);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  width: 100%; max-width: 560px;
  margin: auto;
  display: flex; flex-direction: column;
  box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
  /* Clip horizontal overflow. CSS promotes the `visible`
     axis to `auto` whenever the other is non-visible, so
     without this a wide descendant would let the user drag
     the modal left/right. */
  overflow-x: clip;
}
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.modal-title {
  font-family: var(--font-display); font-size: 14px; font-weight: 900;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text);
}
/* Body no longer needs its own scroll, backdrop handles it. */
.modal-body { padding: 1.1rem 1.25rem; }
.modal-hint {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  margin-bottom: 1rem;
}
.widget-toggles {
  display: flex; flex-direction: column; gap: 0.4rem;
}
.widget-toggle {
  display: flex; align-items: flex-start; gap: 0.6rem;
  padding: 0.6rem 0.7rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: grab;
  transition: all 0.15s;
}
.widget-toggle:hover { border-color: var(--cyan); }
.widget-toggle input { accent-color: var(--cyan); margin-top: 0.2rem; }
.widget-toggle-text { flex: 1; min-width: 0; }
.widget-toggle-label {
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  color: var(--text);
}
.widget-toggle-desc {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.2rem;
}
.widget-toggle .drag-handle {
  font-family: var(--font-mono); font-size: 14px; color: var(--text-3);
  margin-top: 0.1rem;
}
.widget-toggle.is-dragging   { opacity: 0.4; }
.widget-toggle.is-drop-target { border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan); }
.widget-toggle.is-disabled .widget-toggle-label { color: var(--text-3); }

.msg {
  padding: 0.7rem 0.9rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 12px;
}
.msg-error {
  background: rgba(239,68,68,0.10);
  border: 1px solid rgba(239,68,68,0.4);
  color: var(--red, #ef4444);
}

@media print {
  .header-actions, .date-filter-bar, .modal, .modal-backdrop { display: none !important; }
  .card { break-inside: avoid; page-break-inside: avoid; }
}

/* Phone layout: public spectators tap a score chip on the live
   scoreboard and land here on a 360–414px screen. The 80/1fr/80/80
   and 100/1fr/220 grids defined above overflow at that width, so
   collapse them to a two-line layout. */
@media (max-width: 600px) {
  /* Modal backdrop: generous top/bottom padding so a tall
     form can scroll past iOS Safari's URL/toolbar (~50-90px)
     and the home indicator. Without this the bottom of a
     long form is physically unreachable. */
  .modal-backdrop {
    padding-inline-start: 0.5rem;
    padding-inline-end: 0.5rem;
    padding-top: max(1rem, env(safe-area-inset-top, 1rem));
    padding-bottom: max(5rem, env(safe-area-inset-bottom, 1rem) + 4rem);
  }

  /* Outer padding handled by the global 720px rule in app.css. */
  .profile-wrap { padding: 0; }

  .page-header {
    flex-direction: column;
    align-items: stretch;
    gap: 1rem;
    margin-bottom: 1rem;
    padding-bottom: 1rem;
  }
  .page-title { font-size: 28px; }

  .header-actions {
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .header-actions .btn {
    min-height: 36px;
    flex: 1 1 auto;
  }

  .card { padding: 1rem; }

  /* Bar rows: collapse the fixed 80/1fr/80/80 grid. Label and
     numeric value share the top row; the bar gets the full width
     beneath; the per-row "N dives" meta sits beside the value.
     Stacked over wrap because the bar needs a full-width track to
     read at a glance, a wrapped half-width bar is hard to compare
     across rows. */
  .bar-row {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "label value"
      "track track"
      "meta  meta";
    row-gap: 0.25rem;
  }
  .bar-row .bar-label { grid-area: label; }
  .bar-row .bar-value { grid-area: value; text-align: end; }
  .bar-row .bar-track { grid-area: track; }
  .bar-row .bar-meta  { grid-area: meta; }

  /* Compare row: stack label, bars, and values vertically.
     220px right column was the chief overflow culprit, on phones
     the You/Panel numbers wrap cleanly below the bars. */
  .compare-row {
    grid-template-columns: 1fr;
    gap: 0.4rem;
  }
  .compare-vals {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  /* Stat strip: 140px min was already auto-fit, but cap to 2 cols
     on phones so numbers stay readable. */
  .stat-strip {
    grid-template-columns: repeat(2, 1fr);
    padding: 0.75rem;
  }

  /* Tables: let the wide diver/recent-meets/per-event tables
     scroll horizontally rather than crush columns to unreadable
     widths. */
  .pb-table {
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    white-space: nowrap;
  }
}

/* Make sure the bar fills always have a visible height even if a
   container collapses the track. Belt and braces, the track is
   10px tall so absolute-positioned fills already show, but if a
   future change makes the track flex, fills won't vanish. */
.signed-fill, .hist-fill, .bar-fill { min-height: 4px; }
</style>
