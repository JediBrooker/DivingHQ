<script setup>
// P8 secondary-surfaces drawer. Closed by default in ControlViewV2 (the
// whole panel is v-if-gated there), so a resting Live canvas carries NONE
// of this markup -- the #9 subtraction. Within the drawer ONE section is
// open at a time and each section's heavy child / fetch is deferred until
// its first open. Reserves/audit reuse the SAME endpoints ControlView.vue
// hits (loadReserves 1737, audit-recent 272); broadcast reuses the intact
// BroadcastModal; sponsor reuses SponsorLogosManager. No new business rule.
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import BroadcastModal from '@/components/control/BroadcastModal.vue'
import SponsorLogosManager from '@/components/manager/SponsorLogosManager.vue'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({ event: { type: Object, default: null } })
const emit = defineEmits(['close'])

const auth = useAuthStore()
const panelEl = ref(null)
const broadcastModal = ref(null)

// One section open at a time; the heavy child mounts only on first open.
const openSection = ref('')
const broadcastMounted = ref(false)
function toggle(section) {
  openSection.value = openSection.value === section ? '' : section
  if (openSection.value === 'reserves' && !reservesLoaded.value) loadReserves()
  if (openSection.value === 'audit' && !auditLoaded.value) loadAudit()
}

// --- Broadcast: lazy-mount the intact chooser, then open it imperatively.
async function launchBroadcast() {
  broadcastMounted.value = true
  await nextTick()
  broadcastModal.value?.open()
}

// --- Reserves (GET /reserves + POST /promote, reused verbatim) ---
const reserves = ref([])
const reservesLoading = ref(false)
const reservesLoaded = ref(false)
const promoting = ref(null)
async function loadReserves() {
  if (!props.event) return
  reservesLoading.value = true
  try {
    const r = await auth.apiFetch(`/api/events/${props.event.id}/reserves`)
    reserves.value = Array.isArray(r.reserves) ? r.reserves : []
  } catch {
    reserves.value = []
  } finally {
    reservesLoading.value = false
    reservesLoaded.value = true
  }
}
async function promote(competitorId) {
  if (!props.event) return
  promoting.value = competitorId
  try {
    const res = await auth.apiFetch(
      `/api/events/${props.event.id}/reserves/${competitorId}/promote`,
      { method: 'POST', body: JSON.stringify({}) },
    )
    showSuccess(
      res.replaced_name
        ? `Promoted to slot #${res.display_order}, replacing ${res.replaced_name}.`
        : `Promoted to slot #${res.display_order}.`,
    )
    await loadReserves()
  } catch (err) {
    showError(`Failed to promote: ${err.message}`)
  } finally {
    promoting.value = null
  }
}

// --- Audit (GET /audit-recent, reused verbatim) ---
const auditRows = ref([])
const auditLoading = ref(false)
const auditLoaded = ref(false)
async function loadAudit() {
  if (!props.event) return
  auditLoading.value = true
  try {
    const rows = await auth.apiFetch(`/api/events/${props.event.id}/audit-recent?limit=10`)
    auditRows.value = Array.isArray(rows) ? rows : []
  } catch {
    auditRows.value = []
  } finally {
    auditLoading.value = false
    auditLoaded.value = true
  }
}

// --- a11y: Escape closes; focus moves in on open, restores on unmount. ---
let prevFocus = null
function onKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}
onMounted(async () => {
  prevFocus = document.activeElement
  document.addEventListener('keydown', onKeydown, true)
  await nextTick()
  panelEl.value?.focus()
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus()
})
</script>

<template>
  <div class="cv2-drawer-overlay" @mousedown.self="emit('close')">
    <aside
      ref="panelEl"
      class="cv2-drawer"
      role="dialog"
      aria-label="Tools and secondary surfaces"
      tabindex="-1"
    >
      <header class="cv2-drawer-head">
        <h2 class="cv2-drawer-title">Tools</h2>
        <button type="button" class="cv2-drawer-close" aria-label="Close drawer" @click="emit('close')">✕</button>
      </header>

      <!-- BROADCAST -->
      <section class="cv2-drawer-section">
        <button
          type="button"
          class="cv2-drawer-row"
          :aria-expanded="openSection === 'broadcast'"
          @click="toggle('broadcast')"
        >
          <span>📡 Broadcast</span><span aria-hidden="true">{{ openSection === 'broadcast' ? '▾' : '▸' }}</span>
        </button>
        <div v-if="openSection === 'broadcast'" class="cv2-drawer-body cv2-drawer-broadcast">
          <p class="cv2-drawer-hint">Pick the audience and start the projector / venue-bridge feed.</p>
          <button type="button" class="cv2-drawer-action" @click="launchBroadcast">Open broadcast chooser</button>
          <BroadcastModal v-if="broadcastMounted" ref="broadcastModal" :event="event" />
        </div>
      </section>

      <!-- RESERVES -->
      <section class="cv2-drawer-section">
        <button
          type="button"
          class="cv2-drawer-row"
          :aria-expanded="openSection === 'reserves'"
          @click="toggle('reserves')"
        >
          <span>🔁 Reserves</span><span aria-hidden="true">{{ openSection === 'reserves' ? '▾' : '▸' }}</span>
        </button>
        <div v-if="openSection === 'reserves'" class="cv2-drawer-body cv2-drawer-reserves">
          <p v-if="reservesLoading" class="cv2-drawer-hint">Loading reserves…</p>
          <p v-else-if="!reserves.length" class="cv2-drawer-hint">No reserves waiting.</p>
          <ul v-else class="cv2-drawer-list">
            <li v-for="r in reserves" :key="r.competitor_id" class="cv2-drawer-item">
              <span>{{ r.full_name || r.name }}</span>
              <button
                type="button"
                class="cv2-drawer-promote"
                :disabled="promoting === r.competitor_id"
                @click="promote(r.competitor_id)"
              >{{ promoting === r.competitor_id ? '…' : 'Promote' }}</button>
            </li>
          </ul>
        </div>
      </section>

      <!-- AUDIT -->
      <section class="cv2-drawer-section">
        <button
          type="button"
          class="cv2-drawer-row"
          :aria-expanded="openSection === 'audit'"
          @click="toggle('audit')"
        >
          <span>📝 Recent audit</span><span aria-hidden="true">{{ openSection === 'audit' ? '▾' : '▸' }}</span>
        </button>
        <div v-if="openSection === 'audit'" class="cv2-drawer-body cv2-drawer-audit">
          <p v-if="auditLoading" class="cv2-drawer-hint">Loading…</p>
          <p v-else-if="!auditRows.length" class="cv2-drawer-hint">No recent activity.</p>
          <ul v-else class="cv2-drawer-list">
            <li v-for="(row, i) in auditRows" :key="row.id || i" class="cv2-drawer-audit-row">
              {{ row.summary || row.action || row.description || 'Activity' }}
            </li>
          </ul>
        </div>
      </section>

      <!-- SPONSOR -->
      <section class="cv2-drawer-section">
        <button
          type="button"
          class="cv2-drawer-row"
          :aria-expanded="openSection === 'sponsor'"
          @click="toggle('sponsor')"
        >
          <span>🎨 Sponsor branding</span><span aria-hidden="true">{{ openSection === 'sponsor' ? '▾' : '▸' }}</span>
        </button>
        <div v-if="openSection === 'sponsor'" class="cv2-drawer-body cv2-drawer-sponsor">
          <SponsorLogosManager v-if="event && event.meet_id" :meet-id="event.meet_id" />
          <p v-else class="cv2-drawer-hint">This event isn't linked to a meet, so there's no sponsor branding to manage.</p>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.cv2-drawer-overlay {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.45);
  display: flex; justify-content: flex-end;
}
.cv2-drawer {
  width: min(420px, 92vw); height: 100%; overflow-y: auto;
  background: var(--bg-2); border-inline-start: 1px solid var(--border-2);
  padding: 1.25rem; outline: none;
}
.cv2-drawer-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
.cv2-drawer-title { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--fg); }
.cv2-drawer-close {
  border: 1px solid var(--border-2); background: transparent; color: var(--text-2);
  border-radius: var(--radius-sm); width: 2rem; height: 2rem; cursor: pointer;
}
.cv2-drawer-close:hover { color: var(--fg); }
.cv2-drawer-section { border-top: 1px solid var(--border-2); }
.cv2-drawer-row {
  display: flex; align-items: center; justify-content: space-between; width: 100%;
  padding: 0.85rem 0.25rem; border: none; background: transparent; cursor: pointer;
  font-family: var(--font-display); font-size: 14px; font-weight: 600; color: var(--fg);
}
.cv2-drawer-row:hover { color: var(--cyan); }
.cv2-drawer-body { padding: 0.25rem 0.25rem 1rem; }
.cv2-drawer-hint { margin: 0 0 0.75rem; font-family: var(--font-mono); font-size: 12px; color: var(--text-3); }
.cv2-drawer-action {
  padding: 0.5rem 1rem; border-radius: var(--radius-sm);
  border: 1px solid var(--cyan); background: var(--cyan); color: var(--bg);
  font-family: var(--font-display); font-size: 13px; font-weight: 700; cursor: pointer;
}
.cv2-drawer-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.cv2-drawer-item {
  display: flex; align-items: center; justify-content: space-between;
  font-family: var(--font-mono); font-size: 13px; color: var(--text-2);
  padding: 0.35rem 0.25rem;
}
.cv2-drawer-promote {
  padding: 0.25rem 0.65rem; border-radius: var(--radius-sm);
  border: 1px solid var(--green); background: transparent; color: var(--green);
  font-size: 12px; cursor: pointer;
}
.cv2-drawer-promote:disabled { opacity: 0.5; cursor: not-allowed; }
.cv2-drawer-audit-row {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  padding: 0.3rem 0.25rem; border-bottom: 1px solid var(--border-2);
}
</style>
