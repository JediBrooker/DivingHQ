<script setup>
/* SponsorLogosManager: multi-sponsor logo upload + reorder
 * for a single meet.
 *
 * Backend: routes/events/sponsor-logos (added in migration 045
 * plus commit dfd9c0b). The component is self-fetching, pass it
 * a `meetId` and it loads `/api/meets/:id/sponsor-logos`,
 * lets the user upload / reorder / edit / delete via the same
 * REST API, and re-fetches on every successful mutation.
 *
 * Used in two places:
 *   1. ManagerView Edit Meet modal (Phase 2, this commit)
 *   2. Control Room ⋯ menu → "Sponsor branding…" (Phase 4)
 *
 * Behaviour:
 *   • Drag-to-reorder via HTML5 drag-and-drop. Drop fires the
 *     /reorder endpoint wich atomically renumbers slots.
 *   • Inline edit of alt_text + link_url; saves on blur.
 *   • Click-the-trash button to delete; confirms inline.
 *   • Upload via a hidden <input type=file> triggered by the
 *     "+ Upload logo" button. Sends the raw binary as the
 *     POST body with the matching Content-Type and alt/link
 *     as query params. 1MB client-side cap as a guard rail,
 *     the server enforces the real limit.
 *   • Rotation cadence slider (0-60s) writes to a seperate
 *     /sponsor-rotation endpoint.
 *   • Optimistic UI on reorder + delete: the visible list
 *     updates instantly, an error rolls it back and shows
 *     a toast.
 *
 * Legacy fallback: if the API returns a single { legacy: true }
 * row, we render a banner explaining that the sponsor was set
 * via the old single-URL field on the meet, with a button to
 * "Replace with uploads" that drops the legacy field on first
 * successful upload.
 */
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  meetId: { type: String, required: true },
})

const auth = useAuthStore()

const logos = ref([])
const rotationSeconds = ref(8)
const loading = ref(false)
const uploading = ref(false)
const dragIndex = ref(null)
const dropIndex = ref(null)
const fileInput = ref(null)
const savingMeta = ref(new Set())   // logo ids being saved

const hasLegacy = computed(
  () => logos.value.length === 1 && logos.value[0].legacy === true,
)
const realLogos = computed(
  () => logos.value.filter((l) => !l.legacy),
)

async function load() {
  loading.value = true
  try {
    const body = await auth.apiFetch(`/api/meets/${props.meetId}/sponsor-logos`)
    logos.value = Array.isArray(body.logos) ? body.logos : []
    rotationSeconds.value = Number.isFinite(body.rotation_seconds)
      ? body.rotation_seconds
      : 8
  } catch (err) {
    showError(`Failed to load sponsor logos: ${err.message || err}`)
    logos.value = []
  } finally {
    loading.value = false
  }
}

onMounted(load)

// =============================================================
// Upload
// =============================================================
function pickFile() {
  fileInput.value?.click()
}

const MIME_TO_EXT = {
  'image/png':     'png',
  'image/jpeg':    'jpg',
  'image/webp':    'webp',
}
const MAX_BYTES = 1024 * 1024
async function onFilePicked(e) {
  const file = e.target.files?.[0]
  e.target.value = ''   // allow re-picking the same file later
  if (!file) return
  if (!MIME_TO_EXT[file.type]) {
    showError(
      `Unsupported file type "${file.type}". Use PNG, JPEG, or WebP.`,
    )
    return
  }
  if (file.size > MAX_BYTES) {
    showError(
      `File is ${(file.size / 1024).toFixed(0)} KB — limit is 1 MB.`,
    )
    return
  }
  uploading.value = true
  try {
    const buffer = await file.arrayBuffer()
    // Build URL with alt_text seeded from filename so the
    // operator can edit it inline after upload rather than
    // type it twice.
    const altSeed = file.name.replace(/\.[^.]+$/, '').slice(0, 60)
    const url = `/api/meets/${props.meetId}/sponsor-logos`
      + `?alt_text=${encodeURIComponent(altSeed)}`
    await auth.apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: buffer,
    })
    showSuccess('Sponsor logo uploaded')
    await load()
  } catch (err) {
    showError(`Upload failed: ${err.message || err}`)
  } finally {
    uploading.value = false
  }
}

// =============================================================
// Inline metadata edit: alt_text + link_url, save on blur.
// =============================================================
async function saveMeta(logo, patch) {
  if (!logo.id || logo.legacy) return
  savingMeta.value = new Set([...savingMeta.value, logo.id])
  try {
    const body = await auth.apiFetch(
      `/api/meets/${props.meetId}/sponsor-logos/${logo.id}`,
      { method: 'PUT', body: JSON.stringify(patch) },
    )
    // Merge the response back into the local row so cache-busted
    // image_url + updated_at refresh.
    Object.assign(logo, body)
  } catch (err) {
    showError(`Save failed: ${err.message || err}`)
    await load()
  } finally {
    const next = new Set(savingMeta.value)
    next.delete(logo.id)
    savingMeta.value = next
  }
}

function onAltBlur(logo, e) {
  const value = e.target.value.trim() || null
  if (value === (logo.alt_text || null)) return
  saveMeta(logo, { alt_text: value })
}
function onLinkBlur(logo, e) {
  const value = e.target.value.trim() || null
  if (value === (logo.link_url || null)) return
  saveMeta(logo, { link_url: value })
}

// =============================================================
// Delete
// =============================================================
async function remove(logo) {
  if (!logo.id) return
  if (!confirm(`Remove "${logo.alt_text || 'this logo'}"?`)) return
  // Optimistic: drop locally first, restore on error.
  const before = logos.value.slice()
  logos.value = logos.value.filter((l) => l.id !== logo.id)
  try {
    await auth.apiFetch(
      `/api/meets/${props.meetId}/sponsor-logos/${logo.id}`,
      { method: 'DELETE' },
    )
    showSuccess('Logo removed')
  } catch (err) {
    showError(`Delete failed: ${err.message || err}`)
    logos.value = before
  }
}

// =============================================================
// Drag-to-reorder: HTML5 drag events, same pattern as the
// diver-profile widget customize modal.
// =============================================================
function onDragStart(idx, e) {
  dragIndex.value = idx
  e.dataTransfer.effectAllowed = 'move'
  // Required for Firefox, empty payload triggers the drag.
  try { e.dataTransfer.setData('text/plain', String(idx)) } catch {}
}
function onDragOver(idx, e) {
  e.preventDefault()
  if (dragIndex.value === null) return
  dropIndex.value = idx
}
function onDragEnd() {
  dragIndex.value = null
  dropIndex.value = null
}
async function onDrop(idx, e) {
  e.preventDefault()
  const from = dragIndex.value
  dragIndex.value = null
  dropIndex.value = null
  if (from == null || from === idx) return
  const next = realLogos.value.slice()
  const [moved] = next.splice(from, 1)
  next.splice(idx, 0, moved)
  // Optimistic reorder.
  const before = realLogos.value.slice()
  // Renumber locally so the visible order matches the request.
  next.forEach((l, i) => { l.slot_number = i + 1 })
  logos.value = next
  try {
    await auth.apiFetch(
      `/api/meets/${props.meetId}/sponsor-logos/reorder`,
      {
        method: 'PUT',
        body: JSON.stringify({ order: next.map((l) => l.id) }),
      },
    )
  } catch (err) {
    showError(`Reorder failed: ${err.message || err}`)
    logos.value = before
  }
}

// =============================================================
// Rotation cadence: saves on the slider's `change` (mouse-up),
// not `input` (every drag tick), so we don't hammer the server.
// =============================================================
async function saveRotation(e) {
  const n = parseInt(e.target.value, 10)
  if (!Number.isInteger(n) || n < 0 || n > 60) return
  try {
    const body = await auth.apiFetch(
      `/api/meets/${props.meetId}/sponsor-rotation`,
      { method: 'PUT', body: JSON.stringify({ sponsor_rotation_seconds: n }) },
    )
    rotationSeconds.value = body.sponsor_rotation_seconds
  } catch (err) {
    showError(`Rotation save failed: ${err.message || err}`)
  }
}
</script>

<template>
  <div class="sl-mgr">
    <div class="sl-mgr-head">
      <div>
        <div class="sl-mgr-title">Sponsor logos</div>
        <div class="sl-mgr-sub">
          Upload up to several logos — they rotate during the live
          broadcast and appear on the public meet page.
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style="display:none"
        @change="onFilePicked"
      >
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="uploading"
        @click="pickFile"
      >
        {{ uploading ? 'Uploading…' : '+ Upload logo' }}
      </button>
    </div>

    <!-- Legacy fallback banner: heads up, when the meet only has
         the old single-URL sponsor field (no uploads yet), explain
         that and offer the upload affordance. -->
    <div v-if="hasLegacy" class="sl-legacy">
      <div class="sl-legacy-row">
        <img v-if="logos[0].image_url"
             :src="logos[0].image_url"
             :alt="logos[0].alt_text || 'Sponsor'"
             class="sl-legacy-img">
        <div class="sl-legacy-text">
          <div class="sl-legacy-title">Legacy sponsor</div>
          <div class="sl-legacy-desc">
            "{{ logos[0].alt_text || 'Sponsor' }}" — set via the old
            external URL. Upload a new logo to replace it.
          </div>
        </div>
      </div>
    </div>

    <div v-if="loading && !logos.length" class="sl-empty">
      Loading…
    </div>

    <ul v-else-if="realLogos.length" class="sl-list">
      <li
        v-for="(logo, idx) in realLogos"
        :key="logo.id"
        :class="['sl-row',
                 dragIndex === idx ? 'is-dragging' : '',
                 dropIndex === idx && dragIndex !== idx ? 'is-drop-target' : '']"
        draggable="true"
        @dragstart="onDragStart(idx, $event)"
        @dragover="onDragOver(idx, $event)"
        @drop="onDrop(idx, $event)"
        @dragend="onDragEnd"
      >
        <span class="sl-drag" aria-label="Drag to reorder" v-tip="'Drag to reorder'">⋮⋮</span>
        <img :src="logo.image_url" :alt="logo.alt_text || 'Sponsor'" class="sl-thumb">
        <div class="sl-fields">
          <label class="sl-label">
            <span class="sl-label-text">Alt text</span>
            <input
              class="input sl-input"
              type="text"
              :value="logo.alt_text || ''"
              placeholder="e.g. Speedo"
              @blur="onAltBlur(logo, $event)"
            >
          </label>
          <label class="sl-label">
            <span class="sl-label-text">Link (optional)</span>
            <input
              class="input sl-input"
              type="url"
              :value="logo.link_url || ''"
              placeholder="https://…"
              @blur="onLinkBlur(logo, $event)"
            >
          </label>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-sm sl-remove"
          v-tip="'Remove this logo'"
          @click="remove(logo)"
        >✕</button>
      </li>
    </ul>

    <div v-else-if="!hasLegacy" class="sl-empty">
      No sponsor logos yet. Click <strong>+ Upload logo</strong> to add one.
    </div>

    <!-- Rotation cadence. Only relevant when there are 2+ logos
         (a single logo doesn't rotate). -->
    <div v-if="realLogos.length >= 2" class="sl-rotation">
      <label class="sl-rotation-label">
        <span class="sl-rotation-title">Rotation cadence</span>
        <span class="sl-rotation-value">
          {{ rotationSeconds === 0 ? 'No rotation' : `${rotationSeconds}s per logo` }}
        </span>
      </label>
      <input
        type="range"
        min="0"
        max="60"
        step="1"
        :value="rotationSeconds"
        @change="saveRotation"
        class="sl-rotation-slider"
        aria-label="Sponsor rotation cadence in seconds"
      >
      <div class="sl-rotation-hint">
        How long each logo shows during the broadcast before
        the next one slides in. 0 disables rotation.
      </div>
    </div>
  </div>
</template>

<style scoped>
.sl-mgr {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.sl-mgr-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.sl-mgr-title {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--text);
}
.sl-mgr-sub {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  margin-top: 0.15rem;
  line-height: 1.4;
}

.sl-empty {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
  padding: 1.25rem 0.5rem;
  background: var(--bg-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}

.sl-legacy {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: var(--radius-sm);
  padding: 0.65rem 0.85rem;
}
.sl-legacy-row {
  display: flex; align-items: center; gap: 0.85rem;
}
.sl-legacy-img {
  width: 40px; height: 40px; object-fit: contain;
  background: white; border-radius: 4px; padding: 2px;
}
.sl-legacy-title {
  font-family: var(--font-display); font-size: 11px;
  font-weight: 800; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--amber);
}
.sl-legacy-desc {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3); margin-top: 0.15rem; line-height: 1.4;
}

.sl-list {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.sl-row {
  display: grid;
  grid-template-columns: 24px 56px 1fr auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.65rem 0.75rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 0.12s, opacity 0.12s, transform 0.12s;
}
.sl-row.is-dragging   { opacity: 0.4; }
.sl-row.is-drop-target {
  border-color: var(--cyan);
  background: rgba(6, 182, 212, 0.06);
  transform: translateY(-1px);
}
.sl-drag {
  cursor: grab;
  color: var(--text-3);
  font-size: 14px;
  text-align: center;
  user-select: none;
  /* Touch-friendly target: the drag handle is the only column
     that initiates the drag, so keep it tappable on phones too. */
  min-width: 32px; min-height: 32px;
  display: flex; align-items: center; justify-content: center;
}
.sl-drag:active { cursor: grabbing; }
.sl-thumb {
  width: 56px; height: 40px; object-fit: contain;
  background: white;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px;
}
.sl-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  min-width: 0;
}
.sl-label {
  display: flex; flex-direction: column; gap: 0.2rem;
  min-width: 0;
}
.sl-label-text {
  font-family: var(--font-display); font-size: 9px;
  font-weight: 700; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--text-3);
}
.sl-input {
  font-size: 12px;
  padding: 0.4rem 0.55rem;
  min-width: 0;
  width: 100%;
}
.sl-remove {
  color: var(--text-3);
  min-width: 32px; min-height: 32px;
}
.sl-remove:hover { color: var(--red); }

.sl-rotation {
  display: flex; flex-direction: column; gap: 0.35rem;
  padding: 0.75rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-top: 0.25rem;
}
.sl-rotation-label {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem;
}
.sl-rotation-title {
  font-family: var(--font-display); font-size: 11px;
  font-weight: 800; letter-spacing: 0.04em; color: var(--text);
}
.sl-rotation-value {
  font-family: var(--font-mono); font-size: 11px; color: var(--cyan);
}
.sl-rotation-slider {
  width: 100%; accent-color: var(--cyan);
}
.sl-rotation-hint {
  font-family: var(--font-mono); font-size: 10px;
  color: var(--text-3); line-height: 1.4;
}

@media (max-width: 600px) {
  /* Stack the row contents vertically on phones: the inline
     three-column "fields" grid can't fit a 360px viewport. */
  .sl-row {
    grid-template-columns: 24px 56px 1fr;
    grid-template-rows: auto auto;
    row-gap: 0.5rem;
  }
  .sl-fields {
    grid-column: 1 / -1;
    grid-template-columns: 1fr;
  }
  .sl-remove {
    grid-row: 1; grid-column: 3;
    justify-self: end;
  }
}
</style>
