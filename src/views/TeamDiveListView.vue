<script setup>
import { ref, computed, onMounted } from 'vue'
import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { DIVE_DIRECTORY_TTL_MS } from '@/lib/cache-policy'
import { diveDescription } from '@/composables/useDiveLabel'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { t } = useI18n()

const teamId  = computed(() => route.params.teamId)
const eventId = computed(() => route.params.eventId)

const team = ref(null)            // { id, name, short_code, org_id, ... }
const members = ref([])           // [{ id, full_name, ... }]
const event = ref(null)           // event metadata
const directory = ref([])         // dive_directory rows
const rounds = ref([])            // editor state per round
const loading = ref(true)
const saving = ref(false)
const errorMsg = ref('')

// Modal for picking a dive
const showDiveModal = ref(false)
// Lock background scroll while the dive-picker modal is open.
useBodyScrollLock().lockWhile(showDiveModal)
const diveModalRoundIdx = ref(-1)
const diveSearch = ref('')

const eventHeight = computed(() => {
  if (!event.value?.height) return null
  return parseFloat(event.value.height)
})

// Mirrors the server-side rule in loadEventForEntries() — the
// team's dive list is editable only while the event is still
// 'Upcoming' AND the manager-set entries deadline (if any) is
// still in the future. Late roster changes after that point go
// through the controller's late-entry feature.
const isAcceptingEntries = computed(() => {
  const ev = event.value
  if (!ev) return false
  if (ev.status && ev.status !== 'Upcoming') return false
  if (ev.entries_close_at && new Date(ev.entries_close_at) <= new Date()) return false
  return true
})

const closedReason = computed(() => {
  const ev = event.value
  if (!ev) return ''
  if (ev.status && ev.status !== 'Upcoming') {
    return `"${ev.name}" has already started — entries are closed.`
  }
  if (ev.entries_close_at && new Date(ev.entries_close_at) <= new Date()) {
    return `Entries for "${ev.name}" closed at ${new Date(ev.entries_close_at).toLocaleString()}.`
  }
  return ''
})

const filteredDives = computed(() => {
  const term = diveSearch.value.trim().toLowerCase()
  return directory.value.filter(d => {
    if (eventHeight.value !== null && parseFloat(d.height) !== eventHeight.value) return false
    if (!term) return true
    return (
      (d.dive_code + d.position).toLowerCase().includes(term) ||
      (d.description || '').toLowerCase().includes(term)
    )
  }).slice(0, 30)
})

// One row per round. Each row holds: type, divers, dive.
function blankRow(roundNumber) {
  return {
    round_number: roundNumber,
    type: 'individual',          // 'individual' | 'synchro'
    competitor_id: '',
    partner_id: '',
    dive: null,
  }
}

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    const [allEvents, teamMembers, existingList, allDives, allTeamsInOrg] = await Promise.all([
      auth.apiFetch('/api/events'),
      auth.apiFetch(`/api/teams/${teamId.value}/members`),
      auth.apiFetch(`/api/teams/${teamId.value}/events/${eventId.value}/dive-list`),
      auth.cachedApiFetch('/api/dive-directory', {
        cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS },
      }),
      // Load the team itself by listing the user's org teams; we
      // don't have a direct GET /api/teams/:id endpoint, but we
      // can locate the team via the org listing.
      auth.apiFetch(`/api/orgs/${auth.user.org_id}/teams`),
    ])

    event.value = allEvents.find(e => e.id === eventId.value) || null
    if (!event.value) {
      errorMsg.value = 'Event not found.'
      return
    }
    members.value = teamMembers
    directory.value = allDives

    // Try to find the team in the user's org; fall back to a
    // synthetic placeholder if the team is in another org and
    // the user is a system admin.
    team.value = (allTeamsInOrg || []).find(t => t.id === teamId.value)
      || { id: teamId.value, name: 'Team', short_code: null }

    // Pre-fill rounds from existing list (or blank rows)
    const existing = new Map(existingList.map(r => [r.round_number, r]))
    rounds.value = []
    for (let r = 1; r <= (event.value.total_rounds || 6); r++) {
      const e = existing.get(r)
      if (e) {
        rounds.value.push({
          round_number: r,
          type: e.partner_id ? 'synchro' : 'individual',
          competitor_id: e.competitor_id,
          partner_id: e.partner_id || '',
          dive: e.dive_id ? {
            id: e.dive_id,
            dive_code: e.dive_code,
            position: e.position,
            dd: e.dd,
            description: e.description,
            height: e.height,
          } : null,
        })
      } else {
        rounds.value.push(blankRow(r))
      }
    }
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}

function openDivePicker(idx) {
  diveModalRoundIdx.value = idx
  diveSearch.value = ''
  showDiveModal.value = true
}

function pickDive(d) {
  if (diveModalRoundIdx.value < 0) return
  rounds.value[diveModalRoundIdx.value].dive = d
  showDiveModal.value = false
}

function setType(idx, type) {
  rounds.value[idx].type = type
  if (type === 'individual') rounds.value[idx].partner_id = ''
}

const totalDD = computed(() =>
  rounds.value.reduce((sum, r) => sum + (r.dive ? parseFloat(r.dive.dd) : 0), 0).toFixed(1),
)

const isComplete = computed(() => rounds.value.every(r => {
  if (!r.dive || !r.competitor_id) return false
  if (r.type === 'synchro' && (!r.partner_id || r.partner_id === r.competitor_id)) return false
  return true
}))

async function save() {
  if (!isComplete.value) {
    errorMsg.value = 'Every round needs a dive, a diver, and (for synchro rounds) a partner.'
    return
  }
  // Server gates this too, but fail fast on a stale tab so the
  // manager doesn't watch the spinner spin to a 409.
  if (!isAcceptingEntries.value) {
    errorMsg.value = closedReason.value
    return
  }
  saving.value = true
  errorMsg.value = ''
  try {
    await auth.apiFetch(`/api/teams/${teamId.value}/dive-lists`, {
      method: 'POST',
      body: JSON.stringify({
        event_id: eventId.value,
        dives: rounds.value.map(r => ({
          round_number: r.round_number,
          competitor_id: r.competitor_id,
          partner_id: r.type === 'synchro' ? r.partner_id : null,
          dive_id: r.dive.id,
        })),
      }),
    })
    router.push('/teams')
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-header">
    <div>
      <div class="page-label">{{ $t('competitor.page_label') }}</div>
      <h1 class="page-title">{{ team?.name || '…' }}</h1>
      <div v-if="event" class="page-sub">
        {{ event.name }} · {{ event.gender }} · {{ event.height || '—' }} · {{ event.total_rounds }} rounds
      </div>
    </div>
    <RouterLink to="/teams" class="btn btn-ghost">← {{ $t('teams.title') }}</RouterLink>
  </div>

  <div class="main">
    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="errorMsg" class="msg msg-error">{{ errorMsg }}</div>
    <template v-else>
      <div v-if="!isAcceptingEntries" class="msg msg-error" style="margin-bottom:0.75rem">
        {{ closedReason }} You can no longer edit this dive list.
      </div>
      <div v-else-if="event?.entries_close_at" class="hint-line" style="margin-bottom:0.75rem">
        Entries close {{ new Date(event.entries_close_at).toLocaleString() }}.
      </div>
      <div class="header-bar">
        <div class="dd-summary">
          <div class="dd-num">{{ totalDD }}</div>
          <div class="dd-label">Total DD</div>
        </div>
        <button class="btn btn-primary"
                :disabled="saving || !isComplete || !isAcceptingEntries"
                @click="save">
          {{ saving ? 'Saving…'
             : !isAcceptingEntries ? 'Entries closed'
             : 'Save dive list' }}
        </button>
      </div>

      <div class="rounds">
        <div v-for="(r, idx) in rounds" :key="r.round_number"
             :class="['round-card', r.dive ? 'filled' : '']">
          <div class="round-num">Round {{ r.round_number }}</div>

          <div class="round-controls">
            <div class="type-toggle">
              <button :class="['type-btn', r.type === 'individual' ? 'active' : '']"
                      @click="setType(idx, 'individual')">Individual</button>
              <button :class="['type-btn', r.type === 'synchro' ? 'active synchro' : '']"
                      @click="setType(idx, 'synchro')">Synchro</button>
            </div>

            <div class="member-pickers">
              <div class="field">
                <label class="field-label">{{ r.type === 'synchro' ? 'Diver A' : 'Diver' }}</label>
                <select class="select" v-model="r.competitor_id">
                  <option value="">— Select —</option>
                  <option v-for="m in members" :key="m.id" :value="m.id">{{ m.full_name }}</option>
                </select>
              </div>
              <div v-if="r.type === 'synchro'" class="field">
                <label class="field-label">Diver B</label>
                <select class="select" v-model="r.partner_id">
                  <option value="">— Select —</option>
                  <option v-for="m in members.filter(x => x.id !== r.competitor_id)"
                          :key="m.id" :value="m.id">{{ m.full_name }}</option>
                </select>
              </div>
            </div>
          </div>

          <div class="dive-slot" @click="openDivePicker(idx)">
            <template v-if="r.dive">
              <div class="dive-code">
                {{ r.dive.dive_code }}<span class="dive-pos">{{ r.dive.position }}</span>
              </div>
              <div class="dive-desc">{{ diveDescription(r.dive) }}</div>
              <div class="dive-dd">DD {{ r.dive.dd }}</div>
            </template>
            <template v-else>
              <div class="dive-placeholder">Tap to pick a dive…</div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>

  <!-- Dive picker modal -->
  <div v-if="showDiveModal" class="modal-backdrop" @click.self="showDiveModal = false">
    <div class="dive-modal">
      <div class="dive-modal-head">
        <h3>Pick a dive</h3>
        <button class="btn btn-ghost btn-sm" @click="showDiveModal = false">Close ✕</button>
      </div>
      <input class="input" type="text" v-model="diveSearch" placeholder="Search code or description (e.g. 101C)…">
      <div class="dive-modal-body">
        <p v-if="!filteredDives.length" class="empty">No dives match.</p>
        <div v-for="d in filteredDives" :key="d.id" class="dive-result" @click="pickDive(d)">
          <div>
            <div class="dive-code">{{ d.dive_code }}<span class="dive-pos">{{ d.position }}</span></div>
            <div class="dive-desc">{{ diveDescription(d) }}</div>
          </div>
          <div class="dive-result-right">
            <div class="dive-dd">DD {{ d.dd }}</div>
            <div class="dive-h">{{ d.height }}m</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 1.5rem 2rem; border-bottom: 1px solid var(--border);
  max-width: 1200px; margin: 0 auto;
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.4rem; }
.page-title { font-family: var(--font-display); font-size: 36px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.4rem; }

.main { max-width: 1200px; margin: 0 auto; padding: 1.5rem 2rem; display: flex; flex-direction: column; gap: 1.25rem; }
.empty { font-family: var(--font-mono); font-size: 13px; color: var(--text-3); padding: 2rem 0; text-align: center; }

.header-bar {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: 0.875rem 1.25rem;
}
.dd-summary { display: flex; align-items: baseline; gap: 0.6rem; }
.dd-num { font-family: var(--font-display); font-size: 28px; font-weight: 900; font-style: italic; color: var(--cyan); }
.dd-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); }

.rounds { display: flex; flex-direction: column; gap: 0.75rem; }
.round-card {
  display: grid; grid-template-columns: 80px 1fr 280px;
  gap: 1rem; align-items: center;
  padding: 1rem 1.25rem;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.round-card.filled { border-color: var(--cyan); background: var(--cyan-dim); }
.round-num {
  font-family: var(--font-display); font-size: 14px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-2);
}
.round-controls { display: flex; flex-direction: column; gap: 0.6rem; }
.type-toggle {
  display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden;
  width: fit-content;
}
.type-btn {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.4rem 0.75rem; cursor: pointer;
  background: transparent; border: none; color: var(--text-3);
}
.type-btn:hover { color: var(--text-2); }
.type-btn.active { background: var(--cyan-dim); color: var(--cyan); }
.type-btn.active.synchro { background: rgba(139,92,246,0.10); color: #c4b5fd; }

.member-pickers { display: flex; gap: 0.6rem; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 180px; flex: 1; }
.field-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); }

.dive-slot {
  padding: 0.75rem 1rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
  cursor: pointer; transition: border-color 0.15s;
}
.dive-slot:hover { border-color: var(--cyan); }
.dive-code { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--text); }
.dive-pos { color: var(--cyan); }
.dive-desc { font-size: 11px; color: var(--text-3); margin-top: 0.15rem; }
.dive-dd { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--cyan); margin-top: 0.3rem; }
.dive-placeholder { font-size: 12px; color: var(--text-3); font-style: italic; }

/* Dive picker modal — backdrop is the scrollable container
   (not the modal) so the modal can scroll past iOS Safari's
   URL/toolbar instead of being clipped behind it. Parent-
   child DOM: <.modal-backdrop> <.dive-modal>…</.dive-modal> </.modal-backdrop> */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(3, 7, 18, 0.55);
  -webkit-backdrop-filter: blur(2px);  /* iOS Safari */
  backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  padding: 1.5rem;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.dive-modal {
  position: relative;
  z-index: 100;
  width: 100%;
  max-width: 560px;
  margin: auto;
  background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45);
  display: flex; flex-direction: column;
  /* `overflow-x: clip` clips horizontal without creating a
     scroll context; vertical is handled by the backdrop. */
  overflow-x: clip;
  padding: 1rem 1.25rem; gap: 0.75rem;
}
.dive-modal-head { display: flex; align-items: center; justify-content: space-between; }
.dive-modal-head h3 { font-family: var(--font-display); font-size: 18px; font-style: italic; }
.dive-modal-body { overflow-x: clip; }

@media (max-width: 720px) {
  /* Backdrop padding clears iOS Safari's URL/toolbar so the
     bottom rows of the dive list are reachable. */
  .modal-backdrop {
    padding-inline-start: 0.5rem;
    padding-inline-end: 0.5rem;
    padding-top: max(1rem, env(safe-area-inset-top, 1rem));
    padding-bottom: max(5rem, env(safe-area-inset-bottom, 1rem) + 4rem);
  }
}
.dive-result {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.6rem 0.75rem; gap: 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
  cursor: pointer; margin-bottom: 0.4rem;
}
.dive-result:hover { border-color: var(--cyan); }
.dive-result-right { text-align: end; flex-shrink: 0; }
.dive-h { font-size: 10px; color: var(--text-3); margin-top: 0.15rem; }
</style>
