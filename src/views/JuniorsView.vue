<script setup>
// Junior divers (/juniors): divers under 13 that adults look after
// (lib/juniors.js, routes/juniors.js). One page for everyone who has any:
// a parent sees their children, a coach the juniors they coach, a club
// admin every junior in their club. Anyone signed in can add one; the
// server says how (GET /api/juniors/options) and whether it's confirmed
// straight away or goes to whoever confirms that club's divers.
//
// The buttons on each card follow what the server says the viewer may do
// (can.manage, can.remove, can.hand_over), so a coach sees the card and
// none of the editing.
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import EmptyState from '@/components/EmptyState.vue'
import LoadError from '@/components/LoadError.vue'

const { t, locale } = useI18n()
const auth = useAuthStore()

const juniors = ref([])
const options = ref({ clubs: [], genders: ['female', 'male', 'other'], minimum_age: 13 })
const loading = ref(true)
const loadError = ref(false)
// One action at a time per card: the junior's id while it runs.
const busyId = ref(null)

const form = reactive({ club_id: '', full_name: '', date_of_birth: '', gender: '', as: '', consent: false })
const submitting = ref(false)

const editing = ref(null)
const edit = reactive({ full_name: '', date_of_birth: '', gender: '' })
// Per-card inputs, keyed by junior id.
const parentInput = reactive({})
const handoverInput = reactive({})

const today = new Date().toISOString().slice(0, 10)
// The earliest birthday that's still under 13 today, for the date picker.
const earliestJunior = computed(() => {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - options.value.minimum_age)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
})
const tooOld = computed(() => !!form.date_of_birth && form.date_of_birth < earliestJunior.value)

const selectedClub = computed(() => options.value.clubs.find(c => c.id === form.club_id) || null)
const willConfirm = computed(() => !!selectedClub.value?.confirmed_as.includes(form.as))
const canSubmit = computed(() =>
  form.club_id && form.full_name.trim().length >= 2 && form.date_of_birth && !tooOld.value
  && form.gender && form.as && form.consent && !submitting.value)

// An admin mostly adds juniors for the club, a parent for themselves, so
// default to the admin hat when there is one.
watch(selectedClub, (club) => {
  if (!club) { form.as = ''; return }
  if (club.as.includes(form.as)) return
  form.as = ['club', 'org', 'parent', 'coach'].find(a => club.as.includes(a)) || ''
})
// The agreement is for one relation, a new one needs ticking again.
watch(() => form.as, () => { form.consent = false })

function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
  } catch {
    return String(iso).slice(0, 10)
  }
}

function relationLine(j) {
  // While the junior waits, the badge already says so; the parent link
  // rides along with it, so it isn't a second thing to wait on.
  if (j.status === 'pending' && j.you.added) return t('juniors.you_added')
  if (j.you.guardian === 'approved') return t('juniors.you_parent')
  if (j.you.guardian === 'pending') return t('juniors.you_parent_pending')
  if (j.you.club_admin) return t('juniors.you_club')
  if (j.you.coach) return t('juniors.you_coach')
  if (j.you.added) return t('juniors.you_added')
  return ''
}

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const [list, opts] = await Promise.all([
      auth.apiFetch('/api/juniors'),
      auth.apiFetch('/api/juniors/options'),
    ])
    juniors.value = Array.isArray(list) ? list : []
    if (opts?.clubs) options.value = opts
    if (!form.club_id && options.value.clubs.length === 1) form.club_id = options.value.clubs[0].id
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function reloadList() {
  try {
    const list = await auth.apiFetch('/api/juniors')
    juniors.value = Array.isArray(list) ? list : []
  } catch (err) {
    showError(err.message)
  }
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  const name = form.full_name.trim()
  try {
    const out = await auth.apiFetch('/api/juniors', {
      method: 'POST',
      body: JSON.stringify({ ...form, full_name: name }),
    })
    if (out.status === 'link_requested') {
      // Already here (same club, name and birthday): the server asked the
      // club to link this parent to that profile instead of making another.
      showSuccess(t('juniors.link_requested', { name, club: out.club_name || selectedClub.value?.name || '' }))
    } else {
      showSuccess(t(out.status === 'active' ? 'juniors.added_active' : 'juniors.added_pending', { name }))
    }
    Object.assign(form, { full_name: '', date_of_birth: '', gender: '', consent: false })
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    submitting.value = false
  }
}

function startEdit(j) {
  editing.value = j.id
  Object.assign(edit, { full_name: j.full_name, date_of_birth: j.date_of_birth || '', gender: j.gender || '' })
}

async function saveEdit(j) {
  busyId.value = j.id
  try {
    const body = { full_name: edit.full_name.trim(), gender: edit.gender }
    if (edit.date_of_birth) body.date_of_birth = edit.date_of_birth
    await auth.apiFetch(`/api/juniors/${j.id}`, { method: 'PUT', body: JSON.stringify(body) })
    editing.value = null
    showSuccess(t('juniors.saved'))
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function remove(j) {
  const pending = j.status === 'pending'
  if (!await confirmAction({
    title: t(pending ? 'juniors.withdraw_title' : 'juniors.remove_title', { name: j.full_name }),
    body: t(pending ? 'juniors.withdraw_body' : 'juniors.remove_body'),
    confirmLabel: t(pending ? 'juniors.withdraw' : 'juniors.remove'),
    cancelLabel: t('common.cancel'),
    confirmKind: 'danger',
  })) return
  busyId.value = j.id
  try {
    await auth.apiFetch(`/api/juniors/${j.id}`, { method: 'DELETE' })
    showSuccess(t('juniors.removed'))
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function addParent(j) {
  const username = (parentInput[j.id] || '').trim()
  if (!username) return
  busyId.value = j.id
  try {
    const out = await auth.apiFetch(`/api/juniors/${j.id}/parents`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    })
    parentInput[j.id] = ''
    showSuccess(t(out.status === 'approved' ? 'juniors.parent_added' : 'juniors.parent_added_pending'))
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function removeParent(j, p) {
  if (!await confirmAction({
    title: t('juniors.remove_parent_title', { name: p.full_name, child: j.full_name }),
    body: t('juniors.remove_parent_body', { child: j.full_name }),
    confirmLabel: t('juniors.remove_parent'),
    cancelLabel: t('common.cancel'),
    confirmKind: 'danger',
  })) return
  busyId.value = j.id
  try {
    await auth.apiFetch(`/api/juniors/${j.id}/parents/${p.link_id}`, { method: 'DELETE' })
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function sendHandover(j) {
  const email = (handoverInput[j.id] ?? j.handover?.email ?? '').trim()
  if (!email) return
  busyId.value = j.id
  try {
    await auth.apiFetch(`/api/juniors/${j.id}/handover`, { method: 'POST', body: JSON.stringify({ email }) })
    handoverInput[j.id] = undefined
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

async function cancelHandover(j) {
  busyId.value = j.id
  try {
    await auth.apiFetch(`/api/juniors/${j.id}/handover`, { method: 'DELETE' })
    await reloadList()
  } catch (err) {
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="main">
    <header class="head">
      <h1 class="title">{{ $t('juniors.title') }}</h1>
      <p class="intro">{{ $t('juniors.intro') }}</p>
      <RouterLink to="/guide/junior-divers" class="guide-link">{{ $t('juniors.guide_link') }}</RouterLink>
      <!-- What a club admin needs to link a parent to a child they added.
           The @ goes in as a value: vue-i18n reads @ in a message as a link. -->
      <p v-if="auth.user?.username" class="hint" data-testid="junior-your-username">
        {{ $t('juniors.your_username', { username: '@' + auth.user.username }) }}
      </p>
    </header>

    <div v-if="loading" class="muted">{{ $t('common.loading') }}</div>
    <LoadError v-else-if="loadError" @retry="load" />

    <template v-else>
      <section class="block" data-testid="junior-list">
        <h2 class="block-title">{{ $t('juniors.list_title') }}</h2>
        <EmptyState
          v-if="!juniors.length"
          icon="✦"
          :title="$t('juniors.empty_title')"
          :body="$t('juniors.empty_body')"
        />
        <ul v-else class="cards">
          <li v-for="j in juniors" :key="j.id" class="card junior" data-testid="junior-card">
            <div class="junior-head">
              <div class="who">
                <span class="name">{{ j.full_name }}</span>
                <span class="meta">
                  <template v-if="j.age != null">{{ $t('guardians.age_years', { age: j.age }) }}</template>
                  <template v-if="j.club_name"> · {{ j.club_name }}</template>
                </span>
                <span v-if="relationLine(j)" class="meta">{{ relationLine(j) }}</span>
                <!-- Who it's waiting for, by club / region / federation name,
                     so nobody has to work out who runs the club. -->
                <span v-if="j.status === 'pending' && j.waiting_on" class="meta waiting" data-testid="junior-waiting-on">
                  {{ j.waiting_on.via === 'sysadmin' || !j.waiting_on.name
                    ? $t('juniors.waiting_on_divinghq')
                    : $t('juniors.waiting_on', { name: j.waiting_on.name }) }}
                </span>
              </div>
              <span :class="['badge', j.status === 'active' ? 'badge-green' : 'badge-amber']" data-testid="junior-status">
                {{ $t(j.status === 'active' ? 'juniors.status_active' : 'juniors.status_pending') }}
              </span>
            </div>

            <!-- Edit in place: name, birthday, gender. -->
            <form v-if="editing === j.id" class="edit-grid" @submit.prevent="saveEdit(j)">
              <label class="field">
                <span class="label">{{ $t('juniors.field_name') }}</span>
                <input v-model="edit.full_name" class="input" maxlength="100" required>
              </label>
              <label class="field">
                <span class="label">{{ $t('juniors.field_dob') }}</span>
                <input v-model="edit.date_of_birth" class="input" type="date" :max="today" required>
              </label>
              <label class="field">
                <span class="label">{{ $t('juniors.field_gender') }}</span>
                <select v-model="edit.gender" class="select" required>
                  <option v-for="g in options.genders" :key="g" :value="g">{{ $t(`juniors.gender_${g}`) }}</option>
                </select>
              </label>
              <div class="actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="editing = null">{{ $t('common.cancel') }}</button>
                <button type="submit" class="btn btn-primary btn-sm" :disabled="busyId === j.id">{{ $t('common.save') }}</button>
              </div>
            </form>

            <div class="parents">
              <span class="label">{{ $t('juniors.parents') }}</span>
              <p v-if="!j.parents.length" class="muted">{{ $t('juniors.no_parents') }}</p>
              <ul v-else class="parent-list">
                <li v-for="p in j.parents" :key="p.link_id">
                  <span>{{ p.full_name }} <span class="meta">@{{ p.username }}</span></span>
                  <span v-if="p.status === 'pending' && j.status === 'active'" class="badge badge-amber">{{ $t('juniors.parent_waiting') }}</span>
                  <!-- Not while the junior is still waiting: Withdraw below
                       covers that, and the link goes with it. -->
                  <button v-if="j.status === 'active' && (j.can.manage || p.user_id === auth.user?.id)" type="button"
                          class="btn btn-ghost btn-sm" :disabled="busyId === j.id" @click="removeParent(j, p)">
                    {{ $t(p.user_id === auth.user?.id ? 'juniors.remove_me' : 'juniors.remove_parent') }}
                  </button>
                </li>
              </ul>
              <form v-if="j.can.manage" class="inline-form" @submit.prevent="addParent(j)">
                <input v-model="parentInput[j.id]" class="input" :placeholder="$t('juniors.username_placeholder')"
                       :aria-label="$t('juniors.add_parent')" autocomplete="off" autocapitalize="off">
                <button type="submit" class="btn btn-ghost btn-sm" :disabled="busyId === j.id || !parentInput[j.id]">
                  {{ $t('juniors.add_parent') }}
                </button>
              </form>
              <p v-if="j.can.manage" class="hint">{{ $t('juniors.add_parent_hint') }}</p>
            </div>

            <!-- At 13 the diver takes it over (stage 2). -->
            <div v-if="j.can.hand_over" class="handover" data-testid="junior-handover">
              <span class="label">{{ $t('juniors.handover_title', { name: j.full_name }) }}</span>
              <p v-if="j.handover" class="msg msg-success">
                {{ $t('juniors.handover_sent', { email: j.handover.email, date: formatDate(j.handover.expires_at) }) }}
              </p>
              <p v-else class="muted">{{ $t('juniors.handover_body', { name: j.full_name }) }}</p>
              <form class="inline-form" @submit.prevent="sendHandover(j)">
                <input v-model="handoverInput[j.id]" class="input" type="email" :placeholder="$t('juniors.handover_email')"
                       :aria-label="$t('juniors.handover_email')" autocomplete="off">
                <button type="submit" class="btn btn-primary btn-sm" :disabled="busyId === j.id || !handoverInput[j.id]">
                  {{ $t(j.handover ? 'juniors.handover_resend' : 'juniors.handover_send') }}
                </button>
                <button v-if="j.handover" type="button" class="btn btn-ghost btn-sm" :disabled="busyId === j.id"
                        @click="cancelHandover(j)">{{ $t('juniors.handover_cancel') }}</button>
              </form>
            </div>
            <p v-else-if="j.can.manage && j.status === 'active'" class="hint">
              {{ $t('juniors.handover_later', { name: j.full_name }) }}
            </p>

            <div v-if="(j.can.manage || j.can.remove) && editing !== j.id" class="card-actions">
              <button v-if="j.can.manage" type="button" class="btn btn-ghost btn-sm" @click="startEdit(j)">{{ $t('juniors.edit') }}</button>
              <button v-if="j.can.remove" type="button" class="btn btn-ghost btn-sm danger" :disabled="busyId === j.id"
                      @click="remove(j)">{{ $t(j.status === 'pending' ? 'juniors.withdraw' : 'juniors.remove') }}</button>
            </div>
          </li>
        </ul>
      </section>

      <section class="block" data-testid="junior-add">
        <h2 class="block-title">{{ $t('juniors.add_title') }}</h2>
        <p class="muted">{{ $t('juniors.add_intro') }}</p>
        <p v-if="!options.clubs.length" class="muted">{{ $t('juniors.no_clubs') }}</p>
        <form v-else class="card add-form" @submit.prevent="submit">
          <label class="field">
            <span class="label">{{ $t('juniors.field_club') }}</span>
            <select v-model="form.club_id" class="select" required data-testid="junior-club">
              <option value="">{{ $t('juniors.field_club_pick') }}</option>
              <option v-for="c in options.clubs" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="field">
            <span class="label">{{ $t('juniors.field_name') }}</span>
            <input v-model="form.full_name" class="input" maxlength="100" required autocomplete="off" data-testid="junior-name">
          </label>
          <div class="two">
            <label class="field">
              <span class="label">{{ $t('juniors.field_dob') }}</span>
              <input v-model="form.date_of_birth" class="input" type="date" :min="earliestJunior" :max="today" required
                     data-testid="junior-dob">
            </label>
            <label class="field">
              <span class="label">{{ $t('juniors.field_gender') }}</span>
              <select v-model="form.gender" class="select" required data-testid="junior-gender">
                <option value="">{{ $t('juniors.field_gender_pick') }}</option>
                <option v-for="g in options.genders" :key="g" :value="g">{{ $t(`juniors.gender_${g}`) }}</option>
              </select>
            </label>
          </div>
          <p v-if="tooOld" class="msg msg-error">{{ $t('juniors.too_old') }}</p>

          <fieldset v-if="selectedClub" class="field as-field">
            <legend class="label">{{ $t('juniors.field_as') }}</legend>
            <label v-for="a in selectedClub.as" :key="a" class="radio">
              <input v-model="form.as" type="radio" name="junior-as" :value="a" :data-testid="`junior-as-${a}`">
              {{ $t(`juniors.as_${a}`) }}
            </label>
          </fieldset>

          <label v-if="form.as" class="consent">
            <input v-model="form.consent" type="checkbox" data-testid="junior-consent">
            <span>{{ $t(form.as === 'parent' ? 'juniors.consent_parent' : 'juniors.consent_other') }}</span>
          </label>
          <p v-if="form.as" class="hint">{{ $t(willConfirm ? 'juniors.confirm_auto' : 'juniors.confirm_review') }}</p>

          <div class="actions">
            <button type="submit" class="btn btn-primary" :disabled="!canSubmit" data-testid="junior-submit">
              {{ $t('juniors.submit') }}
            </button>
          </div>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
.main {
  max-width: 880px; margin: 0 auto; padding: var(--space-6) var(--space-8);
  display: flex; flex-direction: column; gap: var(--space-8);
}
.head { display: flex; flex-direction: column; gap: var(--space-2); }
.title { font-size: var(--text-h2); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.intro { margin: 0; color: var(--fg-2); font-size: var(--text-sm); max-width: 62ch; line-height: 1.5; }
.guide-link { font-size: var(--text-sm); font-weight: 600; align-self: flex-start; }
.block { display: flex; flex-direction: column; gap: var(--space-3); }
.block-title { font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.junior { display: flex; flex-direction: column; gap: var(--space-4); }
.junior-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); font-size: var(--text-body); overflow-wrap: anywhere; }
.meta { font-size: var(--text-xs); color: var(--fg-3); }
.waiting { color: var(--warn-fg); font-weight: 600; }
.badge { flex-shrink: 0; }
.parents, .handover { display: flex; flex-direction: column; gap: var(--space-2); }
.parent-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.parent-list li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-sm); color: var(--fg); }
.parent-list .btn { margin-inline-start: auto; }
.inline-form { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.inline-form .input { flex: 1; min-width: 12rem; }
.edit-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); align-items: end; }
.edit-grid .actions { grid-column: 1 / -1; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.card-actions { display: flex; gap: var(--space-2); justify-content: flex-end; border-top: 1px solid var(--border); padding-top: var(--space-3); }
.danger { color: var(--danger-fg); }
.add-form { display: flex; flex-direction: column; gap: var(--space-4); }
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.as-field { border: 0; padding: 0; margin: 0; gap: var(--space-2); }
.as-field legend { margin-bottom: var(--space-2); }
.radio, .consent { display: flex; gap: var(--space-2); align-items: flex-start; font-size: var(--text-sm); color: var(--fg); line-height: 1.45; }
.radio input, .consent input { margin-top: 3px; flex-shrink: 0; }
.consent { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; max-width: 64ch; }
.hint { color: var(--fg-3); font-size: var(--text-xs); margin: 0; max-width: 64ch; }
.msg { margin: 0; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .edit-grid, .two { grid-template-columns: minmax(0, 1fr); }
  .junior-head { flex-direction: column; }
}
</style>
