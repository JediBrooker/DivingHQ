<script setup>
// Approve a club that signed up under the federation (migration 096,
// POST /api/clubs/:id/approve). Founders type their club's name and code
// in a hurry on a phone, so the federation gets to tidy them up here
// before the club shows in anyone's list. Making the founder the club's
// admin is ticked by default: they started it, and without an admin a
// club can't host a meet. The server re-checks everything.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  // A pending row from GET /api/clubs (ClubRow).
  club: { type: Object, required: true },
})
const emit = defineEmits(['close', 'done'])

const { t } = useI18n()
const auth = useAuthStore()

const name = ref(props.club.name || '')
const code = ref(props.club.short_code || '')
const regionId = ref(props.club.region_id || '')
const makeAdmin = ref(true)
const regions = ref({ label: null, regions: [] })
const busy = ref(false)
const error = ref('')

const regionLabel = computed(() => t(`regions.label.${regions.value.label || 'region'}`))
const founderName = computed(() => props.club.founder_name || '')

// The club's own org, which for a sysadmin looking at every org isn't
// necessarily the one the Clubs page has regions loaded for.
onMounted(async () => {
  try {
    const body = await auth.apiFetch(`/api/orgs/${props.club.org_id}/regions`)
    if (body?.regions) regions.value = body
  } catch { /* no regions to offer */ }
})

async function submit() {
  if (!name.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const body = {
      name: name.value.trim(),
      short_code: code.value.trim() || null,
      make_founder_admin: !!(props.club.founder_id && makeAdmin.value),
    }
    // Only when there's a list to pick from, otherwise leave it alone.
    if (regions.value.regions.length) body.region_id = regionId.value || null
    const out = await auth.apiFetch(`/api/clubs/${props.club.id}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    emit('done', out)
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal max-width="520px" @close="emit('close')">
    <template #default="{ titleId }">
      <ModalHeader :title-id="titleId" :title="$t('clubs.approve_title')" :subtitle="club.name" @close="emit('close')" />
      <form class="lb-body" data-testid="club-approve-dialog" @submit.prevent="submit">
        <p class="hint intro">{{ $t('clubs.approve_body') }}</p>
        <div class="field">
          <label class="label" for="approve-club-name">{{ $t('clubs.col_name') }}</label>
          <input id="approve-club-name" class="input" type="text" maxlength="80" v-model="name" required>
        </div>
        <div class="field">
          <label class="label" for="approve-club-code">{{ $t('clubs.col_code') }}</label>
          <input id="approve-club-code" class="input" type="text" maxlength="8" v-model="code"
                 autocapitalize="characters" spellcheck="false">
        </div>
        <div v-if="regions.regions.length" class="field">
          <label class="label" for="approve-club-region">{{ regionLabel }}</label>
          <select id="approve-club-region" class="select" v-model="regionId">
            <option value="">—</option>
            <option v-for="r in regions.regions" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </div>
        <label v-if="club.founder_id" class="check">
          <input type="checkbox" v-model="makeAdmin">
          <span>{{ $t('clubs.approve_make_admin', { name: founderName }) }}</span>
        </label>
        <div v-if="error" class="msg msg-error">{{ error }}</div>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">{{ $t('common.cancel') }}</button>
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy || !name.trim()">
            {{ busy ? $t('common.saving') : $t('clubs.approve') }}
          </button>
        </div>
      </form>
    </template>
  </BaseModal>
</template>

<style scoped>
.intro { margin: 0 0 0.9rem; }
.hint { font-size: var(--text-sm); color: var(--fg-3); }
.field { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.9rem; }
.check { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-sm); color: var(--text-2); cursor: pointer; }
.check input { width: 16px; height: 16px; }
.actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem; }
.msg { margin-top: 0.75rem; }
</style>
