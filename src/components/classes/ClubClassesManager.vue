<script setup>
// Club admin: full CRUD on the club's training classes, price options, and
// roster (enrol/edit/remove a diver). Talks to /api/clubs/:clubId/classes*
// which is club-private (requireClubAdminOnly on the server — never reaches
// a federation org_admin).
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import { Plus, Pencil, Trash2, X, Users, Check } from '@lucide/vue'

const props = defineProps({ clubId: { type: String, required: true } })
const auth = useAuthStore()
const { t } = useI18n()

const loading = ref(true)
const classes = ref([])
const expandedId = ref(null)
const roster = ref([])
const rosterLoading = ref(false)

const showCreate = ref(false)
const editingId = ref(null)
const form = ref(blankForm())
const savingClass = ref(false)

function blankForm() {
  return { name: '', level: '', schedule: '', capacity: '', description: '', prices: [] }
}

function money(cents, currency) {
  if (cents == null) return ''
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency || ''}`.trim()
  }
}

async function load() {
  loading.value = true
  try {
    classes.value = await auth.apiFetch(`/api/clubs/${props.clubId}/classes`)
  } catch (e) {
    showError(e.message || t('classes.error_load'))
  } finally {
    loading.value = false
  }
}

let draftPriceSeq = 0
function addPriceRow() {
  form.value.prices.push({ _key: ++draftPriceSeq, label: '', amount: '', currency: 'GBP' })
}
function removePriceRow(i) {
  form.value.prices.splice(i, 1)
}

// Price options for an EXISTING class (edit mode) are managed live against
// the price-option endpoints — not batched with the class save — since a
// club may want to fix/add a tier without touching the class itself, and
// deleting+recreating a class would cascade-wipe its whole roster.
const editPrices = ref([])
const newEditPrice = ref({ label: '', amount: '', currency: 'GBP' })
const savingPriceId = ref(null)
const addingPrice = ref(false)

async function refreshEditPrices() {
  try {
    const list = await auth.apiFetch(`/api/clubs/${props.clubId}/classes`)
    const cls = list.find((c) => c.id === editingId.value)
    editPrices.value = (cls ? cls.price_options : []).map((p) => ({
      id: p.id, label: p.label, amount: (p.amount_cents / 100).toString(), currency: p.currency,
    }))
    classes.value = list
  } catch (e) {
    showError(e.message || t('classes.error_load'))
  }
}

async function saveEditPrice(p) {
  const v = validatePriceRow(p)
  if (v.error) { showError(v.error); return }
  savingPriceId.value = p.id
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${editingId.value}/prices/${p.id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: v.label, amount_cents: v.amount_cents, currency: v.currency, active: true }),
    })
    showSuccess(t('classes.saved'))
    await refreshEditPrices()
  } catch (e) {
    showError(e.message || t('classes.error_save'))
  } finally {
    savingPriceId.value = null
  }
}

async function removeEditPrice(p) {
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${editingId.value}/prices/${p.id}`, { method: 'DELETE' })
    await refreshEditPrices()
  } catch (e) {
    showError(e.message || t('classes.error_save'))
  }
}

function validatePriceRow(p) {
  const label = (p.label || '').trim()
  if (!label) return { error: t('classes.name_required') }
  const amount = Math.round(Number(p.amount) * 100)
  if (!Number.isFinite(amount) || amount < 0) return { error: t('classes.error_save') }
  const currency = (p.currency || '').trim().toUpperCase()
  return { label, amount_cents: amount, currency }
}

async function addEditPrice() {
  const v = validatePriceRow(newEditPrice.value)
  if (v.error) { showError(v.error); return }
  addingPrice.value = true
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${editingId.value}/prices`, {
      method: 'POST',
      body: JSON.stringify({ label: v.label, amount_cents: v.amount_cents, currency: v.currency }),
    })
    newEditPrice.value = { label: '', amount: '', currency: 'GBP' }
    showSuccess(t('classes.saved'))
    await refreshEditPrices()
  } catch (e) {
    showError(e.message || t('classes.error_save'))
  } finally {
    addingPrice.value = false
  }
}

function openCreate() {
  editingId.value = null
  form.value = blankForm()
  showCreate.value = true
}
function openEdit(cls) {
  editingId.value = cls.id
  form.value = {
    name: cls.name, level: cls.level || '', schedule: cls.schedule || '',
    capacity: cls.capacity != null ? String(cls.capacity) : '',
    description: cls.description || '',
    prices: [],
  }
  editPrices.value = (cls.price_options || []).map((p) => ({
    id: p.id, label: p.label, amount: (p.amount_cents / 100).toString(), currency: p.currency,
  }))
  newEditPrice.value = { label: '', amount: '', currency: 'GBP' }
  showCreate.value = true
}
function closeForm() {
  showCreate.value = false
  editingId.value = null
  editPrices.value = []
}

async function saveClass() {
  if (!form.value.name.trim()) {
    showError(t('classes.name_required'))
    return
  }
  savingClass.value = true
  try {
    const body = {
      name: form.value.name.trim(),
      level: form.value.level.trim() || null,
      schedule: form.value.schedule.trim() || null,
      description: form.value.description.trim() || null,
      capacity: form.value.capacity ? Number(form.value.capacity) : null,
    }
    if (editingId.value) {
      await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${editingId.value}`, { method: 'PUT', body: JSON.stringify(body) })
    } else {
      body.price_options = form.value.prices
        .filter((p) => p.label.trim() && p.amount !== '')
        .map((p) => ({ label: p.label.trim(), amount_cents: Math.round(Number(p.amount) * 100), currency: p.currency }))
      await auth.apiFetch(`/api/clubs/${props.clubId}/classes`, { method: 'POST', body: JSON.stringify(body) })
    }
    showSuccess(t('classes.saved'))
    closeForm()
    await load()
  } catch (e) {
    showError(e.message || t('classes.error_save'))
  } finally {
    savingClass.value = false
  }
}

async function toggleActive(cls) {
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${cls.id}`, { method: 'PUT', body: JSON.stringify({ active: !cls.active }) })
    await load()
  } catch (e) {
    showError(e.message || t('classes.error_save'))
  }
}

async function deleteClass(cls) {
  if (!confirm(t('classes.confirm_delete', { name: cls.name }))) return
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${cls.id}`, { method: 'DELETE' })
    if (expandedId.value === cls.id) expandedId.value = null
    showSuccess(t('classes.deleted'))
    await load()
  } catch (e) {
    showError(e.message || t('classes.error_delete'))
  }
}

// ---- roster (expanded class) ------------------------------------
async function toggleRoster(cls) {
  // Always close any open add-diver form when the expanded class changes —
  // it's keyed off expandedId in the template, so leaving it open would
  // otherwise resurface under whichever class is expanded next, still
  // holding the previous class's price-option selection.
  showAdd.value = false
  if (expandedId.value === cls.id) {
    expandedId.value = null
    return
  }
  expandedId.value = cls.id
  rosterLoading.value = true
  try {
    roster.value = await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${cls.id}/roster`)
  } catch (e) {
    showError(e.message || t('classes.error_load'))
    roster.value = []
  } finally {
    rosterLoading.value = false
  }
}

const showAdd = ref(false)
const clubDivers = ref([])
const addForm = ref({ diver_user_id: '', price_option_id: '', discount: '', note: '' })

async function openAdd(cls) {
  showAdd.value = true
  addForm.value = { diver_user_id: '', price_option_id: (cls.price_options && cls.price_options[0]?.id) || '', discount: '', note: '' }
  try {
    clubDivers.value = await auth.apiFetch(`/api/clubs/${props.clubId}/members`)
  } catch {
    clubDivers.value = []
  }
}

async function submitAdd(cls) {
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${cls.id}/enrolments`, {
      method: 'POST',
      body: JSON.stringify({
        diver_user_id: addForm.value.diver_user_id,
        price_option_id: addForm.value.price_option_id || null,
        discount_cents: addForm.value.discount ? Math.round(Number(addForm.value.discount) * 100) : 0,
        note: addForm.value.note.trim() || null,
      }),
    })
    showAdd.value = false
    showSuccess(t('classes.enrolled'))
    roster.value = await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${cls.id}/roster`)
    await load()
  } catch (e) {
    showError(e.message || t('classes.error_enrol'))
  }
}

async function removeEnrolment(cls, enr) {
  if (!confirm(t('classes.confirm_remove', { name: enr.diver_name }))) return
  try {
    await auth.apiFetch(`/api/clubs/${props.clubId}/classes/${cls.id}/enrolments/${enr.id}`, { method: 'DELETE' })
    roster.value = roster.value.filter((r) => r.id !== enr.id)
    await load()
  } catch (e) {
    showError(e.message || t('classes.error_remove'))
  }
}

const isEmpty = computed(() => !loading.value && classes.value.length === 0)

onMounted(load)
</script>

<template>
  <div class="ccm">
    <div class="ccm-head">
      <p class="muted">{{ t('classes.manager_hint') }}</p>
      <button class="btn" type="button" @click="openCreate"><Plus class="ic" />{{ t('classes.new_class') }}</button>
    </div>

    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="isEmpty" class="muted">{{ t('classes.no_classes_yet') }}</p>

    <div v-else class="class-list">
      <div v-for="cls in classes" :key="cls.id" class="class-card" :class="{ inactive: !cls.active }">
        <div class="class-row">
          <div class="class-main">
            <div class="class-name">
              {{ cls.name }}
              <span v-if="!cls.active" class="pill muted-pill">{{ t('classes.inactive') }}</span>
            </div>
            <div class="class-meta">
              <span v-if="cls.level">{{ cls.level }}</span>
              <span v-if="cls.schedule">{{ cls.schedule }}</span>
              <span>{{ t('classes.enrolled_count', { n: cls.enrolment_count, cap: cls.capacity || '∞' }) }}</span>
            </div>
            <div v-if="cls.price_options && cls.price_options.length" class="price-chips">
              <span v-for="p in cls.price_options" :key="p.id" class="chip">{{ p.label }}: {{ money(p.amount_cents, p.currency) }}</span>
            </div>
          </div>
          <div class="class-actions">
            <button class="btn ghost sm" type="button" @click="toggleRoster(cls)"><Users class="ic" />{{ t('classes.roster') }}</button>
            <button class="btn ghost sm" type="button" :aria-label="t('classes.edit_class')" v-tip="t('classes.edit_class')" @click="openEdit(cls)"><Pencil class="ic" /></button>
            <button class="btn ghost sm" type="button" @click="toggleActive(cls)">{{ cls.active ? t('classes.deactivate') : t('classes.activate') }}</button>
            <button class="btn ghost sm danger" type="button" :aria-label="t('common.delete')" v-tip="t('common.delete')" @click="deleteClass(cls)"><Trash2 class="ic" /></button>
          </div>
        </div>

        <div v-if="expandedId === cls.id" class="roster-panel">
          <p v-if="rosterLoading" class="muted">{{ t('common.loading') }}</p>
          <template v-else>
            <div class="roster-head">
              <strong>{{ t('classes.roster') }}</strong>
              <button class="btn ghost sm" type="button" @click="openAdd(cls)"><Plus class="ic" />{{ t('classes.add_diver') }}</button>
            </div>
            <p v-if="!roster.length" class="muted small">{{ t('classes.roster_empty') }}</p>
            <table v-else class="rtable">
              <thead><tr><th>{{ t('classes.col_diver') }}</th><th>{{ t('classes.col_price') }}</th><th>{{ t('classes.col_status') }}</th><th></th></tr></thead>
              <tbody>
                <tr v-for="enr in roster" :key="enr.id">
                  <td>{{ enr.diver_name }}</td>
                  <td>
                    <span v-if="enr.price_label">{{ enr.price_label }}: {{ money(enr.amount_cents, enr.currency) }}</span>
                    <span v-if="enr.discount_cents">&minus;{{ money(enr.discount_cents, enr.currency) }}</span>
                  </td>
                  <td><span class="pill" :class="enr.status">{{ t(`classes.status_${enr.status}`) }}</span></td>
                  <td><button class="btn ghost sm danger" type="button" :aria-label="t('actions.remove')" v-tip="t('actions.remove')" @click="removeEnrolment(cls, enr)"><X class="ic" /></button></td>
                </tr>
              </tbody>
            </table>

            <div v-if="showAdd" class="add-form">
              <select class="in" v-model="addForm.diver_user_id">
                <option value="">{{ t('classes.pick_diver') }}</option>
                <option v-for="d in clubDivers" :key="d.id" :value="d.id">{{ d.full_name }}</option>
              </select>
              <select v-if="cls.price_options && cls.price_options.length" class="in" v-model="addForm.price_option_id">
                <option value="">{{ t('classes.no_charge') }}</option>
                <option v-for="p in cls.price_options" :key="p.id" :value="p.id">{{ p.label }} ({{ money(p.amount_cents, p.currency) }})</option>
              </select>
              <input class="in" type="number" min="0" step="0.01" v-model="addForm.discount" :placeholder="t('classes.discount_optional')" />
              <div class="add-form-actions">
                <button class="btn sm" type="button" :disabled="!addForm.diver_user_id" @click="submitAdd(cls)">{{ t('actions.confirm') }}</button>
                <button class="btn ghost sm" type="button" @click="showAdd = false">{{ t('common.cancel') }}</button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Create / edit panel -->
    <div v-if="showCreate" class="editor-panel">
      <div class="editor-head">
        <strong>{{ editingId ? t('classes.edit_class') : t('classes.new_class') }}</strong>
        <button class="btn ghost sm" type="button" :aria-label="t('common.close')" v-tip="t('common.close')" @click="closeForm"><X class="ic" /></button>
      </div>
      <div class="field"><label>{{ t('classes.field_name') }}</label><input class="in" v-model="form.name" /></div>
      <div class="grid-2">
        <div class="field"><label>{{ t('classes.field_level') }}</label><input class="in" v-model="form.level" /></div>
        <div class="field"><label>{{ t('classes.field_schedule') }}</label><input class="in" v-model="form.schedule" /></div>
      </div>
      <div class="field"><label>{{ t('classes.field_capacity') }}</label><input class="in" type="number" min="1" v-model="form.capacity" /></div>
      <div class="field"><label>{{ t('classes.field_description') }}</label><textarea class="in" rows="2" v-model="form.description"></textarea></div>

      <template v-if="!editingId">
        <label class="field-label">{{ t('classes.price_options') }}</label>
        <p class="muted small">{{ t('classes.price_options_hint') }}</p>
        <div v-for="(p, i) in form.prices" :key="p._key" class="price-row">
          <input class="in" :placeholder="t('classes.price_label_placeholder')" v-model="p.label" />
          <input class="in" type="number" min="0" step="0.01" :placeholder="t('classes.price_amount_placeholder')" v-model="p.amount" />
          <input class="in currency" maxlength="3" v-model="p.currency" />
          <button class="btn ghost sm danger" type="button" :aria-label="t('actions.remove')" v-tip="t('actions.remove')" @click="removePriceRow(i)"><X class="ic" /></button>
        </div>
        <button class="btn ghost sm" type="button" @click="addPriceRow"><Plus class="ic" />{{ t('classes.add_price_option') }}</button>
      </template>

      <template v-else>
        <label class="field-label">{{ t('classes.price_options') }}</label>
        <p class="muted small">{{ t('classes.price_options_hint') }}</p>
        <div v-for="p in editPrices" :key="p.id" class="price-row edit">
          <input class="in" :placeholder="t('classes.price_label_placeholder')" v-model="p.label" />
          <input class="in" type="number" min="0" step="0.01" :placeholder="t('classes.price_amount_placeholder')" v-model="p.amount" />
          <input class="in currency" maxlength="3" v-model="p.currency" />
          <button class="btn ghost sm" type="button" :disabled="savingPriceId === p.id" :aria-label="t('common.save')" v-tip="t('common.save')" @click="saveEditPrice(p)"><Check class="ic" /></button>
          <button class="btn ghost sm danger" type="button" :aria-label="t('actions.remove')" v-tip="t('actions.remove')" @click="removeEditPrice(p)"><X class="ic" /></button>
        </div>
        <div class="price-row">
          <input class="in" :placeholder="t('classes.price_label_placeholder')" v-model="newEditPrice.label" />
          <input class="in" type="number" min="0" step="0.01" :placeholder="t('classes.price_amount_placeholder')" v-model="newEditPrice.amount" />
          <input class="in currency" maxlength="3" v-model="newEditPrice.currency" />
          <button class="btn ghost sm" type="button" :disabled="addingPrice" :aria-label="t('classes.add_price_option')" v-tip="t('classes.add_price_option')" @click="addEditPrice"><Plus class="ic" /></button>
        </div>
      </template>

      <div class="editor-actions">
        <button class="btn" type="button" :disabled="savingClass" @click="saveClass">{{ savingClass ? t('common.saving') : t('common.save') }}</button>
        <button class="btn ghost" type="button" @click="closeForm">{{ t('common.cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ccm { display: flex; flex-direction: column; gap: 1rem; }
.ccm-head { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.muted { color: var(--muted, #777); margin: 0; }
.muted.small, .small { font-size: .82rem; }
.btn { display: inline-flex; align-items: center; gap: .35rem; padding: .5rem 1rem; border: 0; border-radius: var(--radius, .5rem); background: var(--accent, #3b6); color: #fff; cursor: pointer; font: inherit; }
.btn.sm { padding: .3rem .6rem; font-size: .82rem; }
.btn.ghost { background: transparent; color: var(--fg, #222); border: 1px solid var(--border, #ddd); }
.btn.ghost.danger { color: var(--danger, #c33); }
.btn:disabled { opacity: .55; cursor: default; }
.ic { width: 15px; height: 15px; }
.class-list { display: flex; flex-direction: column; gap: .6rem; }
.class-card { border: 1px solid var(--border, #ddd); border-radius: var(--radius-lg, .75rem); padding: .85rem 1rem; }
.class-card.inactive { opacity: .65; }
.class-row { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.class-name { font-weight: 600; display: flex; align-items: center; gap: .4rem; }
.class-meta { display: flex; gap: .75rem; flex-wrap: wrap; font-size: .82rem; color: var(--muted, #777); margin-top: .2rem; }
.price-chips { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .4rem; }
.chip { font-size: .78rem; padding: .1rem .5rem; border-radius: 999px; background: var(--bg-2, #eee); color: var(--fg-2, #555); }
.class-actions { display: flex; gap: .35rem; flex-wrap: wrap; }
.pill { padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; text-transform: capitalize; background: var(--bg-2, #eee); color: var(--fg-2, #555); }
.pill.active { background: var(--accent-soft, #dfe); color: var(--green, #2a7); }
.pill.pending { color: var(--amber, #b70); }
.pill.muted-pill { background: var(--bg-2, #eee); color: var(--muted, #777); font-weight: 600; text-transform: uppercase; font-size: .68rem; }
.roster-panel { margin-top: .75rem; padding-top: .75rem; border-top: 1px solid var(--border, #eee); display: flex; flex-direction: column; gap: .5rem; }
.roster-head { display: flex; align-items: center; justify-content: space-between; }
.rtable { width: 100%; border-collapse: collapse; font-size: .85rem; }
.rtable th, .rtable td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--border, #eee); }
.rtable th { color: var(--muted, #777); font-weight: 600; font-size: .74rem; text-transform: uppercase; }
.add-form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; padding: .5rem; border: 1px dashed var(--border, #ddd); border-radius: var(--radius, .5rem); }
.add-form-actions { display: flex; gap: .4rem; }
.editor-panel { border: 1px solid var(--border, #ddd); border-radius: var(--radius-lg, .75rem); padding: 1rem; display: flex; flex-direction: column; gap: .65rem; }
.editor-head { display: flex; align-items: center; justify-content: space-between; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .85rem; color: var(--fg-2, #555); }
.field-label { font-size: .85rem; color: var(--fg-2, #555); font-weight: 600; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
.in { padding: .4rem .6rem; border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem); background: transparent; color: var(--fg, #222); font: inherit; }
.price-row { display: grid; grid-template-columns: 2fr 1fr 4rem auto; gap: .4rem; align-items: center; }
.price-row.edit { grid-template-columns: 2fr 1fr 4rem auto auto; }
.in.currency { text-transform: uppercase; text-align: center; }
.editor-actions { display: flex; gap: .5rem; }
</style>
