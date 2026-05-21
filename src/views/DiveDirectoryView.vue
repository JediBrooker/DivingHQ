<script setup>
// Dive Directory browser + custom-dive editor.
//
// Reads from GET /api/dive-directory (which returns the World
// Aquatics catalog plus any custom rows the org has added). Custom
// rows surface with is_custom = true and an created_org_id; the UI
// only shows edit/delete affordances when the row is custom AND
// owned by the current org. Core rows render with a lock pill.
//
// The auth gate is set on the route (requiresAuth) so anonymous
// visitors are bounced. Anyone with an org membership can create a
// custom dive; deletes/edits are gated server-side too so a hand-
// crafted curl can't tamper with another org's drill list.
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import { idbInvalidate } from '@/lib/idbCache'
import { DIVE_DIRECTORY_TTL_MS } from '@/lib/cache-policy'

const auth = useAuthStore()

const dives = ref([])
const loading = ref(false)
const errorMsg = ref('')

// Filter state
const searchTerm   = ref('')
const heightFilter = ref('')
const posFilter    = ref('')
const customOnly   = ref(false)

// Create form state
const creating       = ref(false)
const createCode     = ref('')
const createHeight   = ref('')
const createPosition = ref('')
const createDD       = ref('')
const createDesc     = ref('')
const createBusy     = ref(false)
const createError    = ref('')

// Inline edit state — keyed by dive id
const editing  = ref(null)
const editBusy = ref(false)
const editError = ref('')

const HEIGHT_OPTIONS = ['0m', '1m', '3m', '5m', '7.5m', '10m']
const POSITION_OPTIONS = [
  { value: 'A', label: 'A — Straight' },
  { value: 'B', label: 'B — Pike' },
  { value: 'C', label: 'C — Tuck' },
  { value: 'D', label: 'D — Free' },
]

// Postgres returns dive_directory.height as a numeric, which the
// JSON serialiser hands back as a string ("3.0"). Re-coerce for
// comparison + display so a custom row entered as "0m" matches
// "0.0" from the wire.
function fmtHeight(h) {
  if (h == null) return ''
  const n = parseFloat(h)
  if (!Number.isFinite(n)) return String(h)
  // 7.5 keeps its decimal; the others drop the trailing zero.
  return Number.isInteger(n) ? `${n}m` : `${n}m`
}

const filteredDives = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return dives.value.filter(d => {
    if (customOnly.value && !d.is_custom) return false
    if (heightFilter.value && fmtHeight(d.height) !== heightFilter.value) return false
    if (posFilter.value && d.position !== posFilter.value) return false
    if (!term) return true
    // Concatenated forms — "101B", "101 B", "101b 3m" etc all
    // resolve. The bare dive_code / description / position
    // checks were missing the natural way a coach types it
    // (code+position together, no separator) which left a search
    // for "101B" finding nothing even though dive 101 + position
    // B is in the catalog.
    const codePos = `${d.dive_code || ''}${d.position || ''}`.toLowerCase()
    const codePosSp = `${d.dive_code || ''} ${d.position || ''}`.toLowerCase()
    const heightStr = fmtHeight(d.height).toLowerCase()
    return (
      (d.dive_code   || '').toLowerCase().includes(term) ||
      (d.description || '').toLowerCase().includes(term) ||
      (d.position    || '').toLowerCase().includes(term) ||
      codePos.includes(term)   ||
      codePosSp.includes(term) ||
      heightStr.includes(term)
    )
  })
})

const stats = computed(() => ({
  total:  dives.value.length,
  core:   dives.value.filter(d => !d.is_custom).length,
  custom: dives.value.filter(d => d.is_custom).length,
}))

// Roles allowed to create / edit / delete custom dives. Mirrors
// the server-side requireStaff gate in routes/dive-directory.js;
// kept identical here so the UI doesn't dangle buttons that the
// API would reject. Divers + spectators see read-only browse.
const STAFF_ROLES = ['org_admin', 'meet_manager', 'referee', 'judge', 'coach']
const canWrite = computed(() =>
  !!auth.user?.is_system_admin || auth.hasAnyRole(STAFF_ROLES)
)

// Can the current user edit/delete this row? Server enforces it
// too — this just hides the buttons. Four checks: row must be
// custom (core is read-only), viewer must hold a staff role,
// the row must belong to the viewer's org (sysadmin bypass), and
// the row must NOT have been used in a meet yet (lock-on-use
// preserves the scoreboard archive).
function canManage(d) {
  if (!d.is_custom) return false
  if (!canWrite.value) return false
  if (d.in_use) return false
  if (auth.user?.is_system_admin) return true
  return d.created_org_id === auth.user?.org_id
}

async function loadDives() {
  loading.value = true
  errorMsg.value = ''
  try {
    // Cached read: serves the previous fetch instantly while a
    // background revalidation runs. 24h TTL because the catalog
    // is essentially static — only changes when an org adds a
    // custom dive (POST below invalidates manually).
    const result = await auth.cachedApiFetch('/api/dive-directory', {
      cache: { maxAgeMs: DIVE_DIRECTORY_TTL_MS, onUpdate: (fresh) => {
        if (Array.isArray(fresh)) dives.value = fresh
      } },
    })
    dives.value = Array.isArray(result.data) ? result.data : []
  } catch (err) {
    errorMsg.value = err.message
    dives.value = []
  } finally {
    loading.value = false
  }
}

function openCreate() {
  creating.value = true
  createError.value = ''
  // Default to 0m so the new feature's headline use case (poolside
  // drills) is the natural starting point. Operator can change it.
  createCode.value     = ''
  createHeight.value   = '0m'
  createPosition.value = ''
  createDD.value       = ''
  createDesc.value     = ''
}

function cancelCreate() {
  creating.value = false
  createError.value = ''
}

async function submitCreate() {
  createBusy.value = true
  createError.value = ''
  try {
    const body = {
      dive_code:   createCode.value.trim(),
      height:      createHeight.value,
      position:    createPosition.value,
      dd:          parseFloat(createDD.value),
      description: createDesc.value.trim() || null,
    }
    await auth.apiFetch('/api/dive-directory', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    // Invalidate the directory cache across every consumer so the
    // next load (here + any other open tabs/views) picks up the
    // new custom dive.
    await idbInvalidate('/api/dive-directory')
    creating.value = false
    await loadDives()
  } catch (err) {
    createError.value = err.message
  } finally {
    createBusy.value = false
  }
}

function openEdit(d) {
  editing.value = {
    id:          d.id,
    dive_code:   d.dive_code,
    height:      fmtHeight(d.height),
    position:    d.position,
    dd:          String(d.dd),
    description: d.description || '',
  }
  editError.value = ''
}

function cancelEdit() {
  editing.value = null
  editError.value = ''
}

async function submitEdit() {
  editBusy.value = true
  editError.value = ''
  try {
    const body = {
      dive_code:   editing.value.dive_code.trim(),
      height:      editing.value.height,
      position:    editing.value.position,
      dd:          parseFloat(editing.value.dd),
      description: editing.value.description.trim() || null,
    }
    await auth.apiFetch(`/api/dive-directory/${editing.value.id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    await idbInvalidate('/api/dive-directory')
    editing.value = null
    await loadDives()
  } catch (err) {
    editError.value = err.message
  } finally {
    editBusy.value = false
  }
}

async function deleteDive(d) {
  if (!await confirmAction({
    title: `Delete custom dive ${d.dive_code}${d.position}?`,
    body:  `${fmtHeight(d.height)} · DD ${parseFloat(d.dd).toFixed(1)}`,
    consequences: [
      'Existing dive list rows referencing this code keep their stored DD',
      'Future searches in the dive picker won\'t surface it',
      'World Aquatics core dives are protected and never deletable',
    ],
    confirmLabel: 'Delete dive',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/dive-directory/${d.id}`, { method: 'DELETE' })
    await idbInvalidate('/api/dive-directory')
    await loadDives()
    showSuccess(`Deleted ${d.dive_code}${d.position}`)
  } catch (err) {
    showError(err.message)
  }
}

onMounted(loadDives)
</script>

<template>
  <div class="page-header">
    <h1 class="page-title">{{ $t('dive_directory.title') }}</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <!-- Stats strip: total / core / custom counts so the operator
         can tell at a glance how many of each they have. -->
    <div class="stats-strip">
      <div class="stat">
        <div class="stat-num">{{ stats.total.toLocaleString() }}</div>
        <div class="stat-label">Total dives</div>
      </div>
      <div class="stat">
        <div class="stat-num">{{ stats.core.toLocaleString() }}</div>
        <div class="stat-label">Core (read-only)</div>
      </div>
      <div :class="['stat', stats.custom ? 'stat-cyan' : '']">
        <div class="stat-num">{{ stats.custom.toLocaleString() }}</div>
        <div class="stat-label">Custom</div>
      </div>
    </div>

    <p class="page-sub">
      Browse the World Aquatics catalog and add your org's own progression /
      drill dives — including 0m poolside entries. Core dives are read-only
      so the standard tariffs stay protected; custom dives can be edited or
      removed by anyone in the org that created them.
    </p>

    <!-- Filters + create -->
    <div class="toolbar">
      <input class="input" type="text" v-model="searchTerm"
             :placeholder="$t('dive_directory.filter_search')">
      <select class="select" v-model="heightFilter">
        <option value="">All heights</option>
        <option v-for="h in HEIGHT_OPTIONS" :key="h" :value="h">{{ h }}</option>
      </select>
      <select class="select" v-model="posFilter">
        <option value="">All positions</option>
        <option v-for="p in POSITION_OPTIONS" :key="p.value" :value="p.value">
          {{ p.label }}
        </option>
      </select>
      <label class="custom-toggle">
        <input type="checkbox" v-model="customOnly">
        Custom only
      </label>
      <span class="result-count">
        {{ filteredDives.length.toLocaleString() }} of {{ dives.length.toLocaleString() }}
      </span>
      <!-- Add affordance only for staff roles (org_admin / meet_manager /
           referee / judge / coach + sysadmin). Divers see read-only browse. -->
      <button v-if="canWrite" class="btn btn-primary btn-sm" @click="openCreate">+ Add Custom Dive</button>
      <span v-else class="readonly-pill" v-tip="'Read-only — your role can browse but not modify'">View only</span>
    </div>

    <!-- Inline create form -->
    <div v-if="creating" class="create-block">
      <div class="create-head">Add a custom dive</div>
      <p class="create-help">
        Use this for progression entries (poolside sit-dive, kneel-dive…) or
        club-specific drills. The combination of code + height + position must
        be unique across the whole catalog.
      </p>
      <div class="create-fields">
        <div class="field">
          <label class="label">Dive code</label>
          <input class="input" type="text" v-model="createCode"
                 placeholder="e.g. 100" maxlength="6" required>
        </div>
        <div class="field">
          <label class="label">Height</label>
          <select class="select" v-model="createHeight" required>
            <option value="">— Select —</option>
            <option v-for="h in HEIGHT_OPTIONS" :key="h" :value="h">{{ h }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Position</label>
          <select class="select" v-model="createPosition" required>
            <option value="">— Select —</option>
            <option v-for="p in POSITION_OPTIONS" :key="p.value" :value="p.value">
              {{ p.label }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="label">DD</label>
          <input class="input" type="number" v-model="createDD"
                 step="0.1" min="0.1" max="9.9" placeholder="e.g. 0.6" required>
        </div>
        <div class="field field-wide">
          <label class="label">Description</label>
          <input class="input" type="text" v-model="createDesc"
                 placeholder='e.g. "Sit-dive forward" or "Kneeling fall pike"'
                 maxlength="280">
        </div>
      </div>
      <div v-if="createError" class="form-error">{{ createError }}</div>
      <div class="create-actions">
        <button class="btn btn-ghost btn-sm" @click="cancelCreate">Cancel</button>
        <button class="btn btn-primary btn-sm"
                :disabled="createBusy || !createCode.trim() || !createHeight ||
                           !createPosition || !createDD"
                @click="submitCreate">
          {{ createBusy ? 'Adding…' : 'Add dive' }}
        </button>
      </div>
    </div>

    <!-- Dives table -->
    <div class="card" style="padding:0;overflow:hidden">
      <table class="data-table">
        <thead>
          <tr>
            <th>{{ $t('dive_directory.col_code') }}</th>
            <th>Height</th>
            <th>{{ $t('dive_directory.col_position') }}</th>
            <th class="num-col">{{ $t('dive_directory.col_dd') }}</th>
            <th>{{ $t('dive_directory.col_description') }}</th>
            <th>Source</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="empty-state">Loading…</td>
          </tr>
          <tr v-else-if="errorMsg">
            <td colspan="7" class="empty-state">{{ errorMsg }}</td>
          </tr>
          <tr v-else-if="!filteredDives.length">
            <td colspan="7" class="empty-state">
              {{ dives.length ? $t('dive_directory.no_dives_match') : 'No dives in the directory yet.' }}
            </td>
          </tr>
          <template v-for="d in filteredDives" :key="d.id">
            <!-- Display row -->
            <tr v-if="editing?.id !== d.id" :class="['dive-row', d.is_custom ? 'dive-row-custom' : '']">
              <td><span class="dive-code">{{ d.dive_code }}</span></td>
              <td><span class="dive-height">{{ fmtHeight(d.height) }}</span></td>
              <td>{{ d.position }}</td>
              <td class="num-col"><span class="dive-dd">{{ parseFloat(d.dd).toFixed(1) }}</span></td>
              <td class="desc-cell">{{ d.description || '—' }}</td>
              <td>
                <span v-if="d.is_custom" class="src-pill src-pill-custom">Custom</span>
                <span v-else class="src-pill src-pill-core">Core · 🔒</span>
                <!-- Lock-on-use marker: the row has been filed on
                     a roster or scored in a meet, so it can't be
                     edited or deleted without compromising the
                     scoreboard archive. Surfaces alongside the
                     Custom/Core pill so the operator sees both
                     dimensions of the row's status. -->
                <span v-if="d.in_use" class="src-pill src-pill-locked"
                      v-tip="'Used in a meet — locked to preserve the scoreboard archive'">
                  In use · 🔒
                </span>
              </td>
              <td class="actions-col">
                <template v-if="canManage(d)">
                  <button class="btn btn-ghost btn-sm" @click="openEdit(d)">Edit</button>
                  <button class="btn btn-danger btn-sm" @click="deleteDive(d)">Delete</button>
                </template>
                <span v-else class="dim">—</span>
              </td>
            </tr>
            <!-- Edit row -->
            <tr v-else class="dive-row dive-row-custom dive-row-editing">
              <td>
                <input class="input input-sm" type="text" v-model="editing.dive_code"
                       maxlength="6" autofocus style="max-width:80px">
              </td>
              <td>
                <select class="select select-sm" v-model="editing.height">
                  <option v-for="h in HEIGHT_OPTIONS" :key="h" :value="h">{{ h }}</option>
                </select>
              </td>
              <td>
                <select class="select select-sm" v-model="editing.position">
                  <option v-for="p in POSITION_OPTIONS" :key="p.value" :value="p.value">{{ p.value }}</option>
                </select>
              </td>
              <td class="num-col">
                <input class="input input-sm" type="number" v-model="editing.dd"
                       step="0.1" min="0.1" max="9.9" style="max-width:90px">
              </td>
              <td>
                <input class="input input-sm" type="text" v-model="editing.description"
                       maxlength="280">
              </td>
              <td><span class="src-pill src-pill-custom">Custom</span></td>
              <td class="actions-col">
                <button class="btn btn-ghost btn-sm" @click="cancelEdit">Cancel</button>
                <button class="btn btn-primary btn-sm"
                        :disabled="editBusy || !editing.dive_code.trim() ||
                                   !editing.height || !editing.position || !editing.dd"
                        @click="submitEdit">
                  {{ editBusy ? 'Saving…' : 'Save' }}
                </button>
              </td>
            </tr>
            <tr v-if="editing?.id === d.id && editError" class="error-row">
              <td colspan="7" class="form-error">{{ editError }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1.5rem 2rem; border-bottom: 1px solid var(--border);
  max-width: 1400px; margin: 0 auto;
}
.page-title { font-size: 36px; font-style: italic; }
.page-sub {
  max-width: 1400px; margin: 0 auto; padding: 0 2rem;
  color: var(--text-3); font-size: 13px; line-height: 1.6;
}
.main {
  max-width: 1400px; margin: 0 auto; padding: 1rem 2rem 3rem;
}
.stats-strip {
  display: flex; gap: 1rem; align-items: center;
  padding: 1rem 0; border-bottom: 1px solid var(--border);
  margin-bottom: 1rem;
}
.stat { padding: 0.4rem 1rem; }
.stat-num { font-family: var(--font-display); font-size: 26px; font-weight: 900; font-style: italic; }
.stat-label { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3); }
.stat-cyan .stat-num { color: var(--cyan); }

.toolbar {
  display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap;
  padding: 1rem 0;
}
.toolbar .input { flex: 1; min-width: 200px; }
.toolbar .select { min-width: 130px; }
.custom-toggle {
  display: flex; align-items: center; gap: 0.4rem;
  font-size: 12px; color: var(--text-2); user-select: none;
}
.result-count { font-size: 11px; color: var(--text-3); margin-inline-start: auto; }
.readonly-pill {
  display: inline-block; padding: 0.3rem 0.7rem;
  font-size: 11px; font-family: var(--font-display); font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--text-3); border: 1px solid var(--border); border-radius: 999px;
}

.create-block {
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1.25rem; margin-bottom: 1rem;
}
.create-head {
  font-family: var(--font-display); font-size: 16px; font-weight: 800; font-style: italic;
  margin-bottom: 0.4rem;
}
.create-help { font-size: 12px; color: var(--text-3); margin-bottom: 1rem; line-height: 1.6; }
.create-fields {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.8rem; margin-bottom: 1rem;
}
.field-wide { grid-column: 1 / -1; }
.label { display: block; font-size: 11px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--text-3); margin-bottom: 0.3rem; }
.create-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }

.form-error {
  color: var(--danger);
  font-size: 12px; padding: 0.5rem 0;
}

/* Condense the table — the catalog has 460+ rows so the default
   1rem / 1.25rem cell padding made the page scroll forever. Only
   target rows in this scoped view via :deep so the global
   data-table styling other pages depend on isn't affected. */
:deep(.data-table th) { padding: 0.55rem 0.85rem; font-size: 9.5px; }
:deep(.data-table td) { padding: 0.4rem 0.85rem; }

.dive-row td { vertical-align: middle; font-size: 12.5px; }
.dive-row-custom { background: rgba(6, 182, 212, 0.04); }
.dive-row-editing td { padding: 0.3rem 0.6rem; }
.dive-code, .dive-height { font-family: var(--font-mono); }
.dive-dd { font-family: var(--font-display); font-weight: 700; color: var(--cyan); }
.desc-cell { color: var(--text-2); font-size: 12px; }

.src-pill {
  display: inline-block; padding: 0.1rem 0.45rem;
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  border-radius: 999px; border: 1px solid;
}
.src-pill-core   { color: var(--text-3);  border-color: var(--border); }
.src-pill-custom { color: var(--cyan);    border-color: rgba(6, 182, 212, 0.5);
                   background: rgba(6, 182, 212, 0.08); }
.src-pill-locked { color: var(--amber);   border-color: rgba(245, 158, 11, 0.5);
                   background: rgba(245, 158, 11, 0.08); margin-inline-start: 0.4rem; }

.dim { color: var(--text-3); }
.empty-state { text-align: center; color: var(--text-3); padding: 2rem; }
.error-row td { background: rgba(220, 38, 38, 0.05); }

/* =========================================================
   Phone — under 600 px. Toolbar filters cram against each
   other and the data-table overflows the viewport. Stack
   filter children full-width so each is comfortably tappable,
   let the table scroll inside a `.table-wrap` (added on the
   card wrapper below), and shrink the page-header padding so
   the title doesn't dominate.
   ========================================================= */
@media (max-width: 600px) {
  .page-header { padding: 1rem; }
  .page-title { font-size: 26px; }
  .page-sub { padding: 0 1rem; }
  .stats-strip {
    gap: 0.4rem;
    padding: 0.6rem 0;
    margin-bottom: 0.5rem;
    overflow-x: auto;
    flex-wrap: nowrap;
    scrollbar-width: none;
  }
  .stats-strip::-webkit-scrollbar { display: none; }
  .stat { flex-shrink: 0; padding: 0.3rem 0.7rem; }
  .stat-num { font-size: 20px; }

  .toolbar {
    gap: 0.5rem;
    padding: 0.6rem 0;
  }
  /* Each filter takes a full row so a thumb can land on it
     without clipping the neighbour. The button + count are
     compact and still flex-wrap naturally below. */
  .toolbar .input,
  .toolbar .select { flex: 1 1 100%; min-width: 0; }
  .custom-toggle { flex: 1 1 100%; }
  .result-count { margin-inline-start: 0; flex: 1 1 100%; }

  /* The dives table is 7 columns; force it to scroll inside
     its own container rather than pushing the page wider. The
     card-wrapper already has overflow:hidden so we relax that
     in favour of horizontal scroll via the .data-table parent. */
  .card { overflow-x: auto !important; -webkit-overflow-scrolling: touch; }
  :deep(.data-table) { min-width: 640px; }

  /* Create form fields stack — the auto-fit minmax(140px,1fr)
     already collapses but the gap is too generous on a phone. */
  .create-block { padding: 0.85rem; }
  .create-fields { gap: 0.55rem; }
}
</style>
