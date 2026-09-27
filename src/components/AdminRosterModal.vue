<script setup>
// Who admins a club or a region. Opened from the Clubs screen by the
// federation's org_admin (or a sysadmin); the server enforces the same
// rule. Before this dialog there was no way to appoint one outside the
// database.
//
// Club admins run the meets their club hosts, and its classes, Stripe
// payouts and affiliation payments where those are switched on. Region
// admins (state, province...) reach the meets of every club in the
// region, and their candidates are members of those clubs, so each one
// is shown with the club they come from.
//
// The two used to be separate components that differed only in the URL,
// the name of the candidate list and the wording, which is all `kind`
// picks between here.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { showError } from '@/composables/useNotify'

const props = defineProps({
  kind: { type: String, required: true, validator: (v) => v === 'club' || v === 'region' },
  target: { type: Object, required: true },   // the club or region, { id, name }
})
defineEmits(['close'])

const auth = useAuthStore()
const { t } = useI18n()
const features = useFeaturesStore()

const isClub = computed(() => props.kind === 'club')
const baseUrl = computed(() => `/api/${isClub.value ? 'clubs' : 'regions'}/${props.target.id}/admins`)

// What a club admin's job involves. Hosting the club's own meets always
// is; classes and the money side only while those areas are switched on,
// otherwise we'd be describing screens the new admin can't find.
function clubIntro() {
  if (features.classes && features.payments) return t('my_club.admins_intro')
  if (features.classes) return t('my_club.admins_intro_classes')
  if (features.payments) return t('my_club.admins_intro_payments')
  return t('my_club.admins_intro_meets')
}
const text = computed(() => isClub.value
  ? {
      title: t('my_club.admins'),
      intro: clubIntro(),
      nobody: t('my_club.nobody_admins'),
      pick: t('my_club.pick_member'),
      none: t('my_club.no_other_members'),
    }
  : {
      title: t('my_region.region_admins'),
      intro: t('regions.admins_intro'),
      nobody: t('regions.nobody_admins'),
      pick: t('regions.pick_member'),
      none: t('regions.no_candidates'),
    })

const admins = ref([])
const candidates = ref([])
const loading = ref(true)
const busy = ref(false)
const toAdd = ref('')

// Everyone who could be appointed and isn't already an admin.
const addable = computed(() => {
  const taken = new Set(admins.value.map(a => a.id))
  return candidates.value.filter(m => !taken.has(m.id))
})

async function load() {
  loading.value = true
  try {
    const body = await auth.apiFetch(baseUrl.value)
    admins.value = body.admins || []
    // The club endpoint calls its list members, the region one candidates.
    candidates.value = (isClub.value ? body.members : body.candidates) || []
  } catch (err) {
    showError(err.message)
  } finally {
    loading.value = false
  }
}

async function add() {
  if (!toAdd.value) return
  busy.value = true
  try {
    await auth.apiFetch(baseUrl.value, {
      method: 'POST',
      body: JSON.stringify({ user_id: toAdd.value }),
    })
    toAdd.value = ''
    await load()
  } catch (err) {
    showError(err.message)
  } finally {
    busy.value = false
  }
}

async function remove(admin) {
  busy.value = true
  try {
    await auth.apiFetch(`${baseUrl.value}/${admin.id}`, { method: 'DELETE' })
    await load()
  } catch (err) {
    showError(err.message)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <BaseModal max-width="520px" @close="$emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" :title="text.title" :subtitle="target.name" @close="$emit('close')" />
      <div class="lb-body">
        <p class="hint-line intro">{{ text.intro }}</p>

        <div class="section-label">{{ $t('my_club.current_admins', { n: admins.length }) }}</div>
        <div v-if="loading" class="empty">{{ $t('common.loading') }}</div>
        <ul v-else-if="admins.length" class="admin-list">
          <li v-for="a in admins" :key="a.id" class="admin-row">
            <span class="admin-name">{{ a.full_name }} <span class="admin-user">@{{ a.username }}</span></span>
            <button class="btn btn-danger btn-sm" :disabled="busy" @click="remove(a)">{{ $t('my_club.remove') }}</button>
          </li>
        </ul>
        <div v-else class="empty">{{ text.nobody }}</div>

        <div class="section-label" style="margin-top:1.25rem">{{ $t('my_club.add_admin') }}</div>
        <div class="add-row">
          <select class="select" v-model="toAdd" :disabled="loading || !addable.length" :aria-label="$t('my_club.add_admin')">
            <option value="">{{ text.pick }}</option>
            <option v-for="m in addable" :key="m.id" :value="m.id">
              {{ m.full_name }} (@{{ m.username }})<template v-if="!isClub"> · {{ m.club_name }}</template>
            </option>
          </select>
          <button class="btn btn-primary btn-sm" :disabled="!toAdd || busy" @click="add">{{ $t('my_club.add') }}</button>
        </div>
        <p v-if="!loading && !addable.length" class="hint-line">{{ text.none }}</p>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
.intro { margin: 0 0 1rem; }
.section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.6rem;
}
.admin-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.admin-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.admin-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); }
.admin-user { font-family: var(--font-mono); font-size: 11px; font-weight: 400; color: var(--text-3); margin-inline-start: 0.3rem; }
.empty { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.4rem 0; font-style: italic; }
.add-row { display: flex; gap: 0.5rem; align-items: center; }
.add-row .select { flex: 1; min-width: 0; }
.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.5rem; }
</style>
