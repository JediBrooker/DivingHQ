<script setup>
// Public meet landing page. Shows the meet's metadata (host org,
// venue, dates, sponsor) plus every event nested inside, grouped
// by status. Each event card jumps into the existing
// /scoreboard/:eventId surface for live broadcast or completed
// recap.

import { ref, computed, onMounted, watch } from 'vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { fmtDate } from '@/lib/format'
import { cachedFetch, prefetch } from '@/lib/idbCache'
import { MEET_METADATA_TTL_MS } from '@/lib/cache-policy'
import { groupScoreboardEvents } from '@/composables/useProgressionGroups'
import MeetEventGrid from '@/components/scoreboard/MeetEventGrid.vue'
import SponsorRotation from '@/components/scoreboard/SponsorRotation.vue'
import FeePreviewCard from '@/components/payments/FeePreviewCard.vue'

const route = useRoute()
const router = useRouter()

// Public access purchases shown on the meet page (each hidden until on sale).
const accessKinds = [
  { kind: 'spectator_ticket', title: 'Spectator ticket' },
  { kind: 'livestream', title: 'Livestream access' },
  { kind: 'programme', title: 'Programme' },
]

const meet = ref(null)
const events = ref([])
const participatingOrgs = ref([])
const loading = ref(false)
const error = ref('')

// =============================================================
// Program export chooser — controls which optional sections the
// PDF / CSV pulls in.
//
// Schedule basics (event name + tags + scheduled_at + competitor
// count + status) is always included — that's what makes the
// document a "program". The three optional sections are:
//
//   diveLists — per-event roster + each diver's dive list
//               (code · position · DD · description, with the
//               height shown on mixed-board events).
//   judges    — panel for each event (number, name, country).
//   timing    — estimated event duration. When ticked the
//               operator also picks 30 / 45 / 60 seconds per
//               dive — the cadence varies by federation,
//               warm-up regime, and whether the meet runs a
//               shot clock.
// =============================================================
const exportChooserOpen = ref(false)
// Lock background scroll while the export-chooser modal is open.
useBodyScrollLock().lockWhile(exportChooserOpen)
const exportOpts = ref({
  diveLists: false,
  judges:    false,
  timing:    false,
})
const exportSecondsPerDive = ref(45)        // 30 | 45 | 60

// Build the ?include=… + ?seconds_per_dive=… query string the
// backend parses. Empty params are dropped so the URL stays clean
// for the legacy schedule-only export.
const exportQuery = computed(() => {
  const include = []
  if (exportOpts.value.diveLists) include.push('dive_lists')
  if (exportOpts.value.judges)    include.push('judges')
  if (exportOpts.value.timing)    include.push('timing')
  const params = new URLSearchParams()
  if (include.length)             params.set('include', include.join(','))
  if (exportOpts.value.timing)    params.set('seconds_per_dive', exportSecondsPerDive.value)
  const s = params.toString()
  return s ? `?${s}` : ''
})

const programPdfHref = computed(() =>
  meet.value ? `/api/meets/${meet.value.id}/program.pdf${exportQuery.value}` : '#',
)
const programCsvHref = computed(() =>
  meet.value ? `/api/meets/${meet.value.id}/program.csv${exportQuery.value}` : '#',
)

function closeExportChooser() { exportChooserOpen.value = false }

async function load(id) {
  loading.value = true
  error.value = ''
  meet.value = null
  events.value = []
  try {
    // Cached read: opens of the same meet within MEET_METADATA_TTL_MS
    // (1h) hit IDB instantly while a network revalidation runs.
    // Returns null on error; we fall through to the catch.
    const result = await cachedFetch(
      `/api/meets/${id}`,
      { credentials: 'same-origin' },
      {
        maxAgeMs: MEET_METADATA_TTL_MS,
        onUpdate: (fresh) => {
          if (!fresh) return
          meet.value = fresh.meet
          events.value = Array.isArray(fresh.events) ? fresh.events : []
          participatingOrgs.value = Array.isArray(fresh.participating_orgs)
            ? fresh.participating_orgs : []
        },
      },
    )
    if (!result.data) {
      // Network failed and we have no cache. Surface to UX.
      throw new Error('Failed to load meet')
    }
    const body = result.data
    meet.value = body.meet
    events.value = Array.isArray(body.events) ? body.events : []
    participatingOrgs.value = Array.isArray(body.participating_orgs) ? body.participating_orgs : []

    // Warm caches for the views the user is likely to navigate to
    // next: the dive directory (used by every dive-list editor) +
    // each live event's scoreboard. Fire-and-forget; failures are
    // invisible to the meet page itself.
    const prefetchUrls = ['/api/dive-directory']
    for (const ev of events.value) {
      if (ev.status === 'Live') {
        prefetchUrls.push(`/api/scoreboard/${ev.id}`)
      }
    }
    prefetch(prefetchUrls, { credentials: 'same-origin' })
  } catch (err) {
    error.value = err.message || 'Failed to load meet'
  } finally {
    loading.value = false
  }
}

const liveCount = computed(() => events.value.filter(e => e.status === 'Live').length)
const completedCount = computed(() => events.value.filter(e => e.status === 'Completed').length)
const upcomingCount = computed(() => events.value.filter(e => e.status === 'Upcoming').length)

const liveEvents = computed(() => events.value.filter(e => e.status === 'Live'))
const upcomingEvents = computed(() => events.value.filter(e => e.status === 'Upcoming'))
const completedEvents = computed(() => events.value.filter(e => e.status === 'Completed'))

// Progression grid — one row per discipline, prelim → semi → final
// as aligned columns (same layout as the Scoreboard's meet browser).
const progression = computed(() => groupScoreboardEvents(events.value))
function openEvent(id) { router.push(`/scoreboard/${id}`) }

// fmtDate imported from @/lib/format — single source of truth.

const dateRange = computed(() => {
  if (!meet.value) return ''
  const s = meet.value.start_date
  const e = meet.value.end_date
  if (s && e && s !== e) return `${fmtDate(s)} – ${fmtDate(e)}`
  return fmtDate(s || e)
})

watch(() => route.params.id, (id) => { if (id) load(id) }, { immediate: true })
onMounted(() => { if (route.params.id) load(route.params.id) })
</script>

<template>
  <div class="meet-wrap">
    <!-- Top nav -->
    <div class="meet-nav">
      <nav class="sb-crumbs" aria-label="Breadcrumb">
        <RouterLink to="/scoreboard" class="sb-crumb-link">All Meets</RouterLink>
        <span class="sb-crumb-sep" aria-hidden="true">›</span>
        <span class="sb-crumb-current">{{ meet?.name || 'Meet' }}</span>
      </nav>
      <button v-if="meet"
              type="button"
              class="btn btn-ghost btn-sm"
              v-tip="'Pick what to include (dive lists, judges, timings) then download PDF or CSV'"
              @click="exportChooserOpen = true">
        📄 Program export…
      </button>
    </div>

    <!-- Program export chooser. Modal opens from the Program
         export button above. Schedule basics are always included;
         the three optional sections each carry their own backend
         query token. CSV mirrors the PDF so spectators can pull
         the same data into a spreadsheet. -->
    <div v-if="exportChooserOpen" class="export-backdrop" @mousedown.self="closeExportChooser">
      <div class="export-modal">
        <div class="export-head">
          <div>
            <div class="export-title">📄 Program export</div>
            <div class="export-sub">Tick what to include, pick a format</div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" @click="closeExportChooser">Close</button>
        </div>

        <ul class="export-options">
          <li class="export-option export-option-locked"
              v-tip="'Always included — the program is built on the event schedule'">
            <span class="export-check" aria-hidden="true">✓</span>
            <div class="export-option-text">
              <div class="export-option-title">Event schedule</div>
              <div class="export-option-desc">
                Name, format, age group, gender, height, rounds, judges, scheduled time,
                competitor count, status. Always included.
              </div>
            </div>
          </li>

          <li class="export-option">
            <label>
              <input type="checkbox" v-model="exportOpts.diveLists">
              <div class="export-option-text">
                <div class="export-option-title">Dive lists</div>
                <div class="export-option-desc">
                  Every diver in start-order with their per-round dives (code · position ·
                  DD · description). Withdrawn divers + reserves included for completeness.
                </div>
              </div>
            </label>
          </li>

          <li class="export-option">
            <label>
              <input type="checkbox" v-model="exportOpts.judges">
              <div class="export-option-text">
                <div class="export-option-title">Judge panels</div>
                <div class="export-option-desc">
                  Panel members per event (J-number, name, country).
                </div>
              </div>
            </label>
          </li>

          <li class="export-option">
            <label>
              <input type="checkbox" v-model="exportOpts.timing">
              <div class="export-option-text">
                <div class="export-option-title">Estimated event duration</div>
                <div class="export-option-desc">
                  Per-event ETA + a meet-total summary at the end. You pick the
                  per-dive cadence below.
                </div>
              </div>
            </label>
            <!-- Cadence picker — only relevant when timing is ticked.
                 Three federation-typical defaults; tighter cadences
                 fit a meet with a shot clock and snappy operator,
                 60 s suits a junior meet with deliberate warm-ups. -->
            <div v-if="exportOpts.timing" class="export-timing">
              <span class="export-timing-label">Seconds per dive</span>
              <div class="export-timing-pills" role="radiogroup" aria-label="Seconds per dive">
                <label v-for="n in [30, 45, 60]" :key="n"
                       :class="['export-timing-pill', exportSecondsPerDive === n ? 'is-active' : '']">
                  <input type="radio" :value="n" v-model="exportSecondsPerDive">
                  {{ n }}s
                </label>
              </div>
            </div>
          </li>
        </ul>

        <div class="export-actions">
          <a class="btn btn-primary"
             :href="programPdfHref"
             target="_blank" rel="noopener"
             @click="closeExportChooser">
            Download PDF
          </a>
          <a class="btn btn-ghost"
             :href="programCsvHref"
             @click="closeExportChooser">
            Download CSV
          </a>
        </div>
      </div>
    </div>

    <div v-if="loading" class="empty">Loading meet…</div>
    <div v-else-if="error" class="msg msg-error">Couldn't load meet: {{ error }}</div>

    <template v-else-if="meet">
      <!-- Hero -->
      <div class="hero">
        <div class="hero-org">
          {{ meet.org_name }}<span v-if="meet.country_code" class="hero-ctry">{{ meet.country_code }}</span>
        </div>
        <h1 class="hero-title">{{ meet.name }}</h1>
        <div class="hero-meta">
          <span v-if="dateRange">{{ dateRange }}</span>
          <span v-if="meet.venue && dateRange"> · </span>
          <span v-if="meet.venue">{{ meet.venue }}</span>
        </div>
        <p v-if="meet.description" class="hero-desc">{{ meet.description }}</p>

        <!-- Status counts strip -->
        <div class="status-strip">
          <div v-if="liveCount" class="status-cell status-live">
            <span class="status-num">{{ liveCount }}</span>
            <span class="status-lbl">Live now</span>
          </div>
          <div v-if="upcomingCount" class="status-cell status-upcoming">
            <span class="status-num">{{ upcomingCount }}</span>
            <span class="status-lbl">Upcoming</span>
          </div>
          <div v-if="completedCount" class="status-cell status-done">
            <span class="status-num">{{ completedCount }}</span>
            <span class="status-lbl">Completed</span>
          </div>
        </div>

        <!-- 🌐 International strip — surfaces every other federation
             that has divers competing in any event of this meet.
             Only renders when there's at least one. The host's own
             country is shown elsewhere (.hero-ctry); this is the
             VISITING countries. -->
        <div v-if="participatingOrgs.length" class="participating-strip">
          <span class="participating-pulse">🌐 International</span>
          <span class="participating-sub">
            Hosted by {{ meet.org_name
              }}<template v-if="meet.country_code"> ({{ meet.country_code }})</template>
            · Visiting:
          </span>
          <span class="participating-list">
            <span v-for="o in participatingOrgs" :key="o.org_id" class="participating-chip"
                  v-tip="o.org_name">
              {{ o.country_code || o.org_name }}
            </span>
          </span>
        </div>

        <!-- Sponsor strip — multi-logo when uploads exist
             (migration 045), legacy single-URL fallback when
             not. SponsorRotation handles both in one
             render path. The "Powered by" preface stays so
             the strip reads consistently with the prior
             layout. The strip is hidden entirely when the
             meet has no sponsor name AND no logos. -->
        <div v-if="meet.sponsor_name || meet.sponsor_logo_url"
             class="sponsor-strip sponsor-strip-inline">
          <span class="sponsor-prefix">Powered by</span>
          <SponsorRotation :meet-id="meet.id" placement="inline" />
          <!-- Fallback: when the rotation has no images (the
               legacy fallback only carries a name, no URL), the
               component renders nothing — show the plain name
               as a final fallback. -->
          <span v-if="meet.sponsor_name && !meet.sponsor_logo_url"
                class="sponsor-name">{{ meet.sponsor_name }}</span>
        </div>
      </div>

      <!-- Meet registration fee — diver-facing preview. Stays hidden
           (hide-when-unset) until a federation sets a registration fee;
           then shows the price with a coming-soon pay action. -->
      <section v-if="meet" class="meet-reg-section">
        <FeePreviewCard
          hide-when-unset
          title="Meet registration"
          :load-url="`/api/meets/${meet.id}/fees`"
          coming-soon-message="Online meet registration is coming soon."
        />
        <!-- Public access purchases — each hidden until the federation puts
             it on sale, then shown with a coming-soon pay action. -->
        <FeePreviewCard
          v-for="a in accessKinds"
          :key="a.kind"
          hide-when-unset
          :title="a.title"
          :load-url="`/api/meets/${meet.id}/access?kind=${a.kind}`"
          :checkout-url="`/api/meets/${meet.id}/access/checkout?kind=${a.kind}`"
          coming-soon-message="Online sales are coming soon."
        />
      </section>

      <!-- Events — one row per discipline, prelim → semi → final
           grouped into aligned columns (same layout as the
           Scoreboard's meet browser). Clicking a stage opens its
           live broadcast or completed recap. -->
      <section v-if="events.length" class="event-section">
        <div class="section-head">
          <span v-if="liveEvents.length" class="live-pulse">LIVE NOW</span>
          <span class="section-title">Events</span>
        </div>
        <MeetEventGrid
          :rows="progression.rows"
          :max-cols="progression.maxCols"
          @select="openEvent"
        />
      </section>

      <div v-if="!events.length" class="empty">
        No events scheduled for this meet yet.
      </div>
    </template>
  </div>
</template>

<style scoped>
.meet-wrap { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
.meet-nav  { margin-bottom: 1rem; display: flex; gap: 0.6rem 1rem; flex-wrap: wrap; align-items: center; justify-content: space-between; }

/* Breadcrumbs — matches the Scoreboard surfaces (All Meets ›
   <Meet>) so navigation reads consistently across pages. */
.sb-crumbs {
  display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
  min-width: 0; font-family: var(--font-sans); font-size: 15px;
}
.sb-crumb-link {
  background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; color: var(--cyan); text-decoration: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 38vw;
}
.sb-crumb-link:hover { text-decoration: underline; }
.sb-crumb-sep { color: var(--text-3); flex-shrink: 0; }
.sb-crumb-current { font-weight: 600; color: var(--fg, var(--text)); min-width: 0; }
.empty     { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

/* Hero */
.hero {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-xl); padding: 2rem 2.25rem;
  margin-bottom: 2rem;
}
.hero-org {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.5rem;
}
.hero-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}
.hero-title {
  font-family: var(--font-display); font-size: clamp(28px, 4.5vw, 48px); font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.05;
  margin-bottom: 0.75rem;
}
.hero-meta {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-2);
}
.hero-desc {
  font-family: var(--font-mono); font-size: 13px; color: var(--text-3);
  line-height: 1.6; margin-top: 1rem; max-width: 720px;
}

.status-strip {
  display: flex; gap: 0.75rem; flex-wrap: wrap;
  margin-top: 1.5rem;
}
.status-cell {
  display: flex; align-items: baseline; gap: 0.5rem;
  padding: 0.6rem 1rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.status-cell.status-live    { border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.06); }
.status-cell.status-upcoming{ border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.06); }
.status-cell.status-done    { border-color: rgba(6,182,212,0.4);  background: rgba(6,182,212,0.04); }
.status-num {
  font-family: var(--font-display); font-size: 24px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.status-cell.status-live    .status-num { color: var(--red);   }
.status-cell.status-upcoming .status-num { color: var(--amber); }
.status-cell.status-done    .status-num { color: var(--cyan);  }
.status-lbl {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}

/* International strip — visiting countries badge above the
   sponsor block on the public meet page. Only renders when at
   least one foreign federation is participating. */
.participating-strip {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  margin-top: 1.25rem;
  padding: 0.55rem 0.85rem;
  background: rgba(34,211,238,0.08);
  border: 1px solid rgba(34,211,238,0.35);
  border-radius: var(--radius);
}
.participating-pulse {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: #67e8f9;
  flex-shrink: 0;
}
.participating-sub {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
}
.participating-list { display: inline-flex; gap: 0.4rem; flex-wrap: wrap; }
.participating-chip {
  font-family: var(--font-display); font-size: 11px; font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--text);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.2rem 0.6rem;
}

.sponsor-strip {
  display: inline-flex; align-items: center; gap: 0.6rem;
  margin-top: 1.25rem; padding: 0.45rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  text-decoration: none; color: inherit;
}
.sponsor-prefix {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3);
}
.sponsor-logo  { height: 28px; max-width: 160px; object-fit: contain; }
.sponsor-name  { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--text); }

/* Event sections */
.event-section { margin-bottom: 2rem; }
.section-head {
  display: flex; align-items: center; gap: 0.75rem;
  margin-bottom: 1rem;
}
.section-title {
  font-family: var(--font-display); font-size: 14px; font-weight: 900;
  font-style: italic; letter-spacing: 0.05em; color: var(--text);
}
.live-pulse {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; padding: 0.25rem 0.65rem;
  background: var(--red); color: white; border-radius: 4px;
  animation: pulse-red 2s infinite;
}
@keyframes pulse-red { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }

@media (max-width: 720px) {
  .meet-wrap { padding: 1rem; }
  .hero { padding: 1.25rem; border-radius: var(--radius-lg); }

  /* Backdrop padding clears iOS Safari's URL/toolbar so the
     bottom of the export-options list + the action buttons
     are reachable. */
  .export-backdrop {
    padding-inline-start: 0.5rem;
    padding-inline-end: 0.5rem;
    padding-top: max(1rem, env(safe-area-inset-top, 1rem));
    padding-bottom: max(5rem, env(safe-area-inset-bottom, 1rem) + 4rem);
  }
}

/* =============================================================
   Program export chooser modal
   ============================================================= */
/* Backdrop is the scrollable container — not the modal — so
   the modal can scroll past iOS Safari's URL/toolbar instead
   of being clipped behind it. */
.export-backdrop {
  position: fixed; inset: 0; z-index: 300;
  background: rgba(3, 7, 18, 0.85);
  -webkit-backdrop-filter: blur(8px);  /* iOS Safari */
  backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.export-modal {
  width: 100%; max-width: 580px;
  margin: auto;
  /* Clip horizontal overflow — CSS promotes a `visible` axis
     to `auto` whenever the other is non-visible. */
  overflow-x: clip;
  background: var(--surface);
  border: 1px solid var(--border-2, var(--border));
  border-top: 4px solid var(--cyan);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
}
.export-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem;
  padding: 1.1rem 1.25rem 0.85rem;
  border-bottom: 1px solid var(--border);
}
.export-title {
  font-family: var(--font-display);
  font-size: 18px; font-weight: 900; font-style: italic;
  color: var(--text);
}
.export-sub {
  font-family: var(--font-mono);
  font-size: 11px; color: var(--text-3);
  margin-top: 0.15rem;
}

.export-options {
  list-style: none; margin: 0;
  padding: 0.85rem 1.25rem 0.4rem;
  display: flex; flex-direction: column; gap: 0.6rem;
}
.export-option { padding: 0.65rem 0.85rem;
  background: var(--bg-3, var(--bg-2)); border: 1px solid var(--border);
  border-radius: var(--radius-sm); }
.export-option label {
  display: grid; grid-template-columns: 24px 1fr; gap: 0.6rem; align-items: start;
  cursor: pointer;
}
.export-option input[type="checkbox"] {
  width: 18px; height: 18px;
  accent-color: var(--cyan);
  margin-top: 0.15rem;
  cursor: pointer;
}
.export-option-text { min-width: 0; }
.export-option-title {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 800;
  color: var(--text); margin-bottom: 0.15rem;
}
.export-option-desc {
  font-family: var(--font-mono);
  font-size: 11px; line-height: 1.45; color: var(--text-3);
}
.export-option-locked {
  display: grid; grid-template-columns: 24px 1fr; gap: 0.6rem; align-items: start;
  background: rgba(6, 182, 212, 0.06);
  border-color: rgba(6, 182, 212, 0.35);
}
.export-option-locked .export-check {
  font-size: 18px; font-weight: 900; color: var(--cyan);
  margin-top: 0.05rem;
}

.export-timing {
  margin-block: 0.55rem 0;
  margin-inline: 30px 0;
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
}
.export-timing-label {
  font-family: var(--font-display);
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
}
.export-timing-pills { display: inline-flex; gap: 0.35rem; }
.export-timing-pill {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.25rem 0.65rem;
  font-family: var(--font-mono); font-size: 12px;
  background: var(--surface); color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 999px; cursor: pointer;
  transition: all 0.12s;
}
.export-timing-pill.is-active {
  background: var(--cyan); color: white; border-color: var(--cyan);
}
.export-timing-pill input { display: none; }

.export-actions {
  display: flex; gap: 0.6rem; justify-content: flex-end;
  padding: 0.85rem 1.25rem 1.1rem;
  border-top: 1px solid var(--border);
}
.export-actions .btn { min-width: 130px; text-align: center; }
</style>
