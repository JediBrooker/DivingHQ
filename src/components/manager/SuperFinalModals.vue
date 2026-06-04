<script setup>
/* SuperFinalModals — the five Super Final dialogs (DWC 2026
 * Appendix 3), extracted from ManagerView.vue.
 *
 * Owns all per-modal state (open flags, payloads, errors,
 * loading flags) and the open/close/confirm handlers. The parent
 * (ManagerView) keeps a template ref so the event-row buttons
 * can call into us via defineExpose. After a successful seed we
 * emit `refresh-events` so the parent can reload its list.
 *
 * Five modals in order of the SF flow:
 *   1. Seed Head-to-Head — preview + confirm pair seeding (§2.1.1)
 *   2. H2H pair results — read-only display once H2H is Live/Completed
 *   3. Seed Semi Final — single-step seed from H2H winners (§3.1)
 *   4. Seed Final — single-step seed from SF top-2-per-group (§3.2)
 *   5. Super Final rankings — official 1-12 list (§7)
 *
 * Backend routes all live in routes/events/super-final-bridge.js.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess } from '@/composables/useNotify'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { RULE_REFERENCES } from '@/lib/ruleReferences'

const auth = useAuthStore()

const emit = defineEmits(['refresh-events'])

// 1. Super Final — H2H seeding modal. Mirrors the openAdvanceModal
// pattern: pull the preview, show the proposed pairs, commit when
// the operator confirms.
const h2hModalOpen     = ref(false)
const h2hEvent         = ref(null)
const h2hMaxPerOrg     = ref(2)        // Appendix 3 §1.1 default
const h2hLockMinutes   = ref(30)       // WA Article 6.7.3
const h2hPreview       = ref(null)     // { pairs, capped_orgs, shortfall, ranked }
const h2hLoading       = ref(false)
const h2hErr           = ref('')
const h2hResults       = ref(null)     // { pairs: [...] } for Live/Completed display

async function openH2hModal(ev) {
  h2hEvent.value     = ev
  h2hPreview.value   = null
  h2hErr.value       = ''
  h2hMaxPerOrg.value = 2
  h2hLockMinutes.value = 30
  h2hModalOpen.value = true
  h2hLoading.value   = true
  try {
    const url = `/api/events/${ev.id}/seed-h2h/preview?max_per_org=${h2hMaxPerOrg.value}`
    h2hPreview.value = await auth.apiFetch(url)
  } catch (err) {
    h2hErr.value = err.message || 'Failed to load preview'
  } finally {
    h2hLoading.value = false
  }
}

async function refreshH2hPreview() {
  if (!h2hEvent.value) return
  h2hLoading.value = true
  h2hErr.value     = ''
  try {
    const url = `/api/events/${h2hEvent.value.id}/seed-h2h/preview?max_per_org=${h2hMaxPerOrg.value}`
    h2hPreview.value = await auth.apiFetch(url)
  } catch (err) {
    h2hErr.value = err.message || 'Failed to load preview'
  } finally {
    h2hLoading.value = false
  }
}

function closeH2hModal() {
  h2hModalOpen.value = false
  h2hEvent.value = null
  h2hPreview.value = null
}

async function confirmH2hSeed() {
  if (!h2hEvent.value) return
  h2hErr.value = ''
  h2hLoading.value = true
  try {
    const result = await auth.apiFetch(`/api/events/${h2hEvent.value.id}/seed-h2h`, {
      method: 'POST',
      body: JSON.stringify({
        max_per_org:  parseInt(h2hMaxPerOrg.value) || 2,
        lock_minutes: parseInt(h2hLockMinutes.value) || 0,
      }),
    })
    showSuccess(`Seeded ${result.seeded} divers across 6 H2H pairs.`)
    closeH2hModal()
    emit('refresh-events')
  } catch (err) {
    h2hErr.value = err.message || 'Failed to seed H2H'
  } finally {
    h2hLoading.value = false
  }
}

// 2. "View pair results" — read-only modal opened on Live or
// Completed super_final_h2h events.
const h2hResultsModalOpen = ref(false)
async function openH2hResultsModal(ev) {
  h2hEvent.value = ev
  h2hResults.value = null
  h2hResultsModalOpen.value = true
  h2hErr.value = ''
  try {
    h2hResults.value = await auth.apiFetch(`/api/events/${ev.id}/super-final/h2h-results`)
  } catch (err) {
    h2hErr.value = err.message || 'Failed to load H2H results'
  }
}
function closeH2hResultsModal() {
  h2hResultsModalOpen.value = false
  h2hEvent.value = null
  h2hResults.value = null
}

// 3. Super Final — Seed Semi Final modal. Simpler than the H2H
// modal: no per-Federation cap, no preview, just a single
// "Confirm" action that posts to seed-semi.
const sfSeedModalOpen = ref(false)
const sfSeedEvent     = ref(null)
const sfSeedLockMin   = ref(30)
const sfSeedLoading   = ref(false)
const sfSeedErr       = ref('')

function openSfSeedModal(ev) {
  sfSeedEvent.value     = ev
  sfSeedLockMin.value   = 30
  sfSeedErr.value       = ''
  sfSeedLoading.value   = false
  sfSeedModalOpen.value = true
}
function closeSfSeedModal() { sfSeedModalOpen.value = false; sfSeedEvent.value = null }
async function confirmSfSeed() {
  if (!sfSeedEvent.value) return
  sfSeedErr.value = ''
  sfSeedLoading.value = true
  try {
    const result = await auth.apiFetch(`/api/events/${sfSeedEvent.value.id}/seed-semi`, {
      method: 'POST',
      body: JSON.stringify({ lock_minutes: parseInt(sfSeedLockMin.value) || 0 }),
    })
    showSuccess(`Seeded ${result.seeded} divers into the Semi Final (${result.sf_rounds} dives).`)
    closeSfSeedModal()
    emit('refresh-events')
  } catch (err) {
    sfSeedErr.value = err.message || 'Failed to seed Semi Final'
  } finally {
    sfSeedLoading.value = false
  }
}

// 4. Super Final — Seed Final modal.
const fSeedModalOpen = ref(false)
const fSeedEvent     = ref(null)
const fSeedLockMin   = ref(15)   // Appendix 3 §4.1 — 15-min break
const fSeedLoading   = ref(false)
const fSeedErr       = ref('')

function openFSeedModal(ev) {
  fSeedEvent.value     = ev
  fSeedLockMin.value   = 15
  fSeedErr.value       = ''
  fSeedLoading.value   = false
  fSeedModalOpen.value = true
}
function closeFSeedModal() { fSeedModalOpen.value = false; fSeedEvent.value = null }
async function confirmFSeed() {
  if (!fSeedEvent.value) return
  fSeedErr.value = ''
  fSeedLoading.value = true
  try {
    const result = await auth.apiFetch(`/api/events/${fSeedEvent.value.id}/seed-final`, {
      method: 'POST',
      body: JSON.stringify({ lock_minutes: parseInt(fSeedLockMin.value) || 0 }),
    })
    showSuccess(`Seeded ${result.seeded} finalists (${result.f_rounds} dives, scores reset).`)
    closeFSeedModal()
    emit('refresh-events')
  } catch (err) {
    fSeedErr.value = err.message || 'Failed to seed Final'
  } finally {
    fSeedLoading.value = false
  }
}

// 5. Merged Super Final rankings — Appendix 3 §7. Opens from
// the Final event's "View Super Final rankings" link.
const superFinalRankingsModalOpen = ref(false)
const superFinalRankings          = ref(null)
const superFinalRankingsErr       = ref('')

// Lock background scroll while any of the 5 super-final modals
// is open — iOS Safari otherwise lets the manager drag the
// underlying events list mid-bracket-setup.
useBodyScrollLock().lockWhile(computed(() =>
  h2hModalOpen.value || h2hResultsModalOpen.value ||
  sfSeedModalOpen.value || fSeedModalOpen.value ||
  superFinalRankingsModalOpen.value
))

async function openSuperFinalRankingsModal(ev) {
  superFinalRankings.value = null
  superFinalRankingsErr.value = ''
  superFinalRankingsModalOpen.value = true
  try {
    superFinalRankings.value = await auth.apiFetch(`/api/events/${ev.id}/super-final/rankings`)
  } catch (err) {
    superFinalRankingsErr.value = err.message || 'Failed to load rankings'
  }
}
function closeSuperFinalRankingsModal() {
  superFinalRankingsModalOpen.value = false
  superFinalRankings.value = null
}

// Surface the openers so ManagerView's event-row buttons can call
// into us via a template ref. We deliberately do NOT expose the
// close handlers — those only need to be reachable from within
// our own template.
defineExpose({
  openH2hModal,
  openH2hResultsModal,
  openSfSeedModal,
  openFSeedModal,
  openSuperFinalRankingsModal,
})
</script>

<template>
  <!-- Super Final — Seed Head-to-Head modal. Mirrors the
       advance modal: preview + a single confirm action. -->
  <div v-if="h2hModalOpen" class="modal-backdrop" @click.self="closeH2hModal">
    <div class="modal modal-advance" @click.stop style="max-width:720px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:22px;font-style:italic">🥊 Seed Head-to-Head</h2>
        <button class="btn btn-ghost btn-sm" @click="closeH2hModal">Cancel ✕</button>
      </div>

      <p class="hint" style="margin-bottom:1rem" v-if="h2hEvent">
        Seed <strong>"{{ h2hEvent.name }}"</strong> from the Stop-1 ranking
        — pairs are 12v1, 11v2, 10v3, 9v4, 8v5, 7v6
        ({{ RULE_REFERENCES.superFinalH2H }}; max {{ h2hMaxPerOrg }} per Federation).
      </p>

      <div v-if="h2hErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ h2hErr }}</div>
      <div v-if="h2hLoading" class="hint" style="margin-bottom:0.75rem">Loading preview…</div>

      <div v-if="!h2hLoading && h2hPreview" class="advance-form">
        <div class="advance-field-row">
          <label class="advance-field">
            <span class="label">Max per Federation</span>
            <input class="input" type="number" min="1" max="12"
                   v-model="h2hMaxPerOrg" @change="refreshH2hPreview">
          </label>
          <label class="advance-field">
            <span class="label">Dive-list lock (minutes)</span>
            <input class="input" type="number" min="0" max="120" v-model="h2hLockMinutes">
        <span class="hint" style="margin-top:0.25rem">
          {{ RULE_REFERENCES.changeWindow }} after the previous stage ended.
        </span>
          </label>
        </div>

        <!-- Capped orgs — surface so the operator sees who got
             dropped because of the per-Federation cap. -->
        <div v-if="h2hPreview.capped_orgs && h2hPreview.capped_orgs.length"
             class="hint" style="margin-top:0.75rem;padding:0.5rem 0.75rem;
                                 border-inline-start:3px solid var(--cyan);
                                 background:rgba(6,182,212,0.08)">
          Per-Federation cap dropped:
          <span v-for="(c, i) in h2hPreview.capped_orgs" :key="c.org_id">
            <strong>{{ c.dropped }}</strong> from one federation<span v-if="i < h2hPreview.capped_orgs.length - 1">, </span>
          </span>
          (<strong>{{ h2hPreview.capped_orgs.reduce((s, c) => s + c.kept_count, 0) }}</strong> kept).
        </div>

        <!-- Shortfall warning -->
        <div v-if="h2hPreview.shortfall" class="msg msg-warn" style="margin-top:0.75rem">
          {{ h2hPreview.shortfall }}
        </div>

        <!-- Pair preview -->
        <div v-if="h2hPreview.pairs && h2hPreview.pairs.length" class="advance-preview"
             style="margin-top:1rem">
          <div class="advance-preview-head">
            6 pairs · 12 divers (G1 = pairs 12v1, 9v4, 8v5 · G2 = pairs 11v2, 10v3, 7v6)
          </div>
          <div v-for="p in h2hPreview.pairs" :key="p.pair_index"
               class="advance-preview-row primary sf-pair-row">
            <span class="advance-rank">G{{ p.group_number }}</span>
            <span class="advance-name">
              <strong>#{{ p.seed_a }}</strong> {{ p.full_name_a }}
              <span v-if="p.country_code_a" class="hint">· {{ p.country_code_a }}</span>
            </span>
            <span style="text-align:center;color:var(--muted)">vs</span>
            <span class="advance-name">
              <strong>#{{ p.seed_b }}</strong> {{ p.full_name_b }}
              <span v-if="p.country_code_b" class="hint">· {{ p.country_code_b }}</span>
            </span>
          </div>
        </div>

        <div style="display:flex;gap:0.5rem;margin-top:1.25rem">
          <button type="button" class="btn btn-ghost" @click="closeH2hModal">Cancel</button>
          <button type="button" class="btn btn-primary"
                  :disabled="h2hLoading || !!h2hPreview.shortfall"
                  @click="confirmH2hSeed">
            {{ h2hLoading ? 'Seeding…' : 'Confirm seeding' }}
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Super Final — H2H pair results modal. Read-only,
       opens on Live/Completed super_final_h2h events. -->
  <div v-if="h2hResultsModalOpen" class="modal-backdrop" @click.self="closeH2hResultsModal">
    <div class="modal modal-advance" @click.stop style="max-width:720px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:22px;font-style:italic">H2H — pair results</h2>
        <button class="btn btn-ghost btn-sm" @click="closeH2hResultsModal">Close ✕</button>
      </div>

      <p class="hint" style="margin-bottom:1rem" v-if="h2hEvent">
        <strong>"{{ h2hEvent.name }}"</strong> — winners advance to the Semi Final.
        Tied pairs need a dive-off under DWC Appendix 3 §6.
      </p>
      <div v-if="h2hErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ h2hErr }}</div>

      <div v-if="h2hResults && h2hResults.pairs" class="advance-preview">
        <div v-for="p in h2hResults.pairs" :key="p.pair_index"
             :class="['advance-preview-row', 'sf-pair-result-row', p.tied ? 'reserve' : 'primary']">
          <span class="advance-rank">G{{ p.group_number }}</span>
          <span class="advance-name" :style="{ fontWeight: p.winner_id === p.competitor_a_id ? '700' : '500' }">
            #{{ p.seed_a }} {{ p.full_name_a }}
          </span>
          <span style="text-align:center" class="hint">{{ Number(p.total_a).toFixed(2) }}</span>
          <span class="advance-name" :style="{ fontWeight: p.winner_id === p.competitor_b_id ? '700' : '500' }">
            #{{ p.seed_b }} {{ p.full_name_b }}
          </span>
          <span style="text-align:center" class="hint">{{ Number(p.total_b).toFixed(2) }}</span>
        </div>
      </div>
      <div v-else-if="!h2hErr" class="hint">Loading…</div>
    </div>
  </div>

  <!-- Super Final — Seed Semi Final modal. -->
  <div v-if="sfSeedModalOpen" class="modal-backdrop" @click.self="closeSfSeedModal">
    <div class="modal modal-advance" @click.stop style="max-width:520px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:22px;font-style:italic">Seed Semi Final</h2>
        <button class="btn btn-ghost btn-sm" @click="closeSfSeedModal">Cancel ✕</button>
      </div>
      <p class="hint" style="margin-bottom:1rem" v-if="sfSeedEvent">
        Seed <strong>"{{ sfSeedEvent.name }}"</strong> with the 6 H2H winners.
        Scores from H2H carry forward. {{ RULE_REFERENCES.superFinalSemi }}.
        Starting order is reversed within each group (lowest H2H total dives first).
      </p>
      <div v-if="sfSeedErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ sfSeedErr }}</div>
      <label class="advance-field">
        <span class="label">Dive-list lock (minutes)</span>
        <input class="input" type="number" min="0" max="120" v-model="sfSeedLockMin">
        <span class="hint" style="margin-top:0.25rem">
          {{ RULE_REFERENCES.changeWindow }}. Default 30 min.
        </span>
      </label>
      <div style="display:flex;gap:0.5rem;margin-top:1.25rem">
        <button type="button" class="btn btn-ghost" @click="closeSfSeedModal">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="sfSeedLoading" @click="confirmSfSeed">
          {{ sfSeedLoading ? 'Seeding…' : 'Confirm seed' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Super Final — Seed Final modal. -->
  <div v-if="fSeedModalOpen" class="modal-backdrop" @click.self="closeFSeedModal">
    <div class="modal modal-advance" @click.stop style="max-width:520px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:22px;font-style:italic">Seed Final</h2>
        <button class="btn btn-ghost btn-sm" @click="closeFSeedModal">Cancel ✕</button>
      </div>
      <p class="hint" style="margin-bottom:1rem" v-if="fSeedEvent">
        Seed <strong>"{{ fSeedEvent.name }}"</strong> with the top 2 from each SF group.
        Scores reset. Highest cumulative SF score dives last. {{ RULE_REFERENCES.superFinalFinal }}.
      </p>
      <div v-if="fSeedErr" class="msg msg-error" style="margin-bottom:0.75rem">{{ fSeedErr }}</div>
      <label class="advance-field">
        <span class="label">Lock window (minutes)</span>
        <input class="input" type="number" min="5" max="60" v-model="fSeedLockMin">
        <span class="hint" style="margin-top:0.25rem">
          {{ RULE_REFERENCES.superFinalFinal }}: 15-min break between SF and F; change requests
          must be made at LATEST 5 minutes before the Final. The effective
          lock is set to NOW() + (this − 5) minutes.
        </span>
      </label>
      <div style="display:flex;gap:0.5rem;margin-top:1.25rem">
        <button type="button" class="btn btn-ghost" @click="closeFSeedModal">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="fSeedLoading" @click="confirmFSeed">
          {{ fSeedLoading ? 'Seeding…' : 'Confirm seed' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Super Final — Official 1-12 rankings (Appendix 3 §7). -->
  <div v-if="superFinalRankingsModalOpen" class="modal-backdrop" @click.self="closeSuperFinalRankingsModal">
    <div class="modal modal-advance" @click.stop style="max-width:680px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
        <h2 style="font-size:22px;font-style:italic">Super Final — Official Rankings</h2>
        <button class="btn btn-ghost btn-sm" @click="closeSuperFinalRankingsModal">Close ✕</button>
      </div>
      <p class="hint" style="margin-bottom:1rem">
        {{ RULE_REFERENCES.superFinalRankings }}: positions 1-4 from the Final stage; 5-6 from
        H2H + SF cumulative (the SF non-finalists); 7-12 from H2H total only
        (the H2H non-advancers).
      </p>
      <div v-if="superFinalRankingsErr" class="msg msg-error" style="margin-bottom:0.75rem">
        {{ superFinalRankingsErr }}
      </div>
      <div v-if="superFinalRankings && superFinalRankings.rankings" class="advance-preview">
        <div v-for="r in superFinalRankings.rankings" :key="r.rank"
             :class="['advance-preview-row', 'sf-ranking-row',
                      r.source === 'final' ? 'primary'
                      : r.source === 'h2h+semi' ? 'reserve'
                      : 'cut']">
          <span class="advance-rank">#{{ r.rank }}</span>
          <span class="advance-name">
            {{ r.full_name }}
            <span v-if="r.country_code" class="hint">· {{ r.country_code }}</span>
          </span>
          <span class="hint" style="text-align: end">
            {{ r.source === 'final' ? 'Final' : r.source === 'h2h+semi' ? 'H2H + SF' : 'H2H only' }}
          </span>
          <span class="advance-total">{{ Number(r.total).toFixed(2) }}</span>
        </div>
      </div>
      <div v-else-if="!superFinalRankingsErr" class="hint">Loading…</div>
    </div>
  </div>
</template>

<style scoped>
/* The shared .advance-preview-row class (in ManagerView.css)
   uses a 4-col grid sized for advance-modal rank/name/total/tag.
   The H2H + rankings modals need different column profiles, so
   these per-row variants override grid-template-columns. The
   inline styles they replaced were:
     sf-pair-row         → 36px 1fr 24px 1fr
     sf-pair-result-row  → 36px 1fr 60px 1fr 60px
     sf-ranking-row      → 36px 1fr 90px 80px
   Mobile (≤600px) collapses each to a stack so the modal can
   live inside 360–414px without horizontal scroll. */
.sf-pair-row        { grid-template-columns: 36px 1fr 24px 1fr; }
.sf-pair-result-row { grid-template-columns: 36px 1fr 60px 1fr 60px; }
.sf-ranking-row     { grid-template-columns: 36px 1fr 90px 80px; }

@media (max-width: 600px) {
  /* G# pins to the left, names + scores stack underneath. The
     "vs" label is decorative on a stacked layout — keep it
     centered across the row. */
  .sf-pair-row {
    grid-template-columns: 36px 1fr;
    row-gap: 0.1rem;
  }
  .sf-pair-row > :nth-child(3) { grid-column: 1 / -1; text-align: start; }

  .sf-pair-result-row {
    grid-template-columns: 36px 1fr auto;
    row-gap: 0.15rem;
  }

  .sf-ranking-row {
    grid-template-columns: 36px 1fr auto;
    row-gap: 0.1rem;
  }
}
</style>
