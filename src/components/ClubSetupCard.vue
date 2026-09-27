<script setup>
// One club's invite link and short code, on My club.
//
// The link is /register?country=<alpha-3>&club=<id>: RegisterView reads
// both and preselects them, so a member who follows it lands in the right
// club without hunting through a country's list. The code is what shows
// next to the club's divers once a meet is set to represent clubs (the
// default for club-hosted meets), so it's worth setting early.
//
// Both come from GET /api/clubs/:id/setup (routes/club-setup.js), which
// also says whether this person may change the code: the club decides
// where there's no federation on DivingHQ, the federation decides under
// one. Emits `updated` after a save so the page can refresh anything
// that shows the code.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'

const props = defineProps({
  club: { type: Object, required: true },   // { id, name }
})
const emit = defineEmits(['updated'])

const { t } = useI18n()
const auth = useAuthStore()

/** @type {import('vue').Ref<import('@/types').ClubSetup|null>} */
const setup = ref(null)
const code = ref('')
const saving = ref(false)
const copyState = ref('idle')   // 'idle' | 'copied' | 'error'

const inviteUrl = computed(() => {
  if (!setup.value?.country_code || typeof window === 'undefined') return ''
  const q = new URLSearchParams({ country: setup.value.country_code, club: setup.value.id })
  return `${window.location.origin}/register?${q}`
})
const codeDirty = computed(() =>
  code.value.trim().toUpperCase() !== (setup.value?.short_code || ''))

async function load() {
  try {
    setup.value = await auth.apiFetch(`/api/clubs/${props.club.id}/setup`)
    code.value = setup.value.short_code || ''
  } catch {
    // Nothing to offer without it; the rest of My club still works.
    setup.value = null
  }
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'error'
  }
  setTimeout(() => { copyState.value = 'idle' }, 1800)
}

async function saveCode() {
  saving.value = true
  try {
    const body = await auth.apiFetch(`/api/clubs/${props.club.id}/short-code`, {
      method: 'PUT',
      body: JSON.stringify({ short_code: code.value.trim() || null }),
    })
    setup.value = { ...setup.value, short_code: body.short_code }
    code.value = body.short_code || ''
    showSuccess(t('my_club.setup.code_saved'))
    emit('updated')
  } catch (err) {
    showError(err.message)
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <section v-if="setup" class="club-setup card-sm" :data-testid="`club-setup-${club.id}`">
    <h2 class="cs-title">{{ club.name }}</h2>

    <div v-if="inviteUrl" class="cs-block">
      <h3 class="cs-label">{{ $t('my_club.setup.invite_title') }}</h3>
      <p class="cs-hint">{{ $t('my_club.setup.invite_body', { club: club.name }) }}</p>
      <div class="cs-row">
        <input class="input cs-url" type="text" :value="inviteUrl" readonly data-testid="club-invite-url"
               :aria-label="$t('setup.wizard.registration_link_aria')" @focus="$event.target.select()">
        <button type="button" class="btn btn-primary btn-sm" @click="copyInvite">
          <span v-if="copyState === 'copied'">{{ $t('setup.wizard.invite_copied') }}</span>
          <span v-else-if="copyState === 'error'">{{ $t('setup.wizard.invite_copy_failed') }}</span>
          <span v-else>{{ $t('setup.wizard.invite_copy') }}</span>
        </button>
      </div>
    </div>

    <div class="cs-block">
      <h3 class="cs-label">
        <label :for="`club-code-${club.id}`">{{ $t('my_club.setup.code_title') }}</label>
      </h3>
      <p class="cs-hint">{{ $t('my_club.setup.code_hint') }}</p>
      <form v-if="setup.can_edit_code" class="cs-row" @submit.prevent="saveCode">
        <input :id="`club-code-${club.id}`" v-model="code" class="input cs-code" type="text" maxlength="8"
               autocapitalize="characters" autocomplete="off" spellcheck="false"
               :placeholder="$t('my_club.setup.code_placeholder')">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="saving || !codeDirty">
          {{ saving ? $t('common.saving') : $t('common.save') }}
        </button>
      </form>
      <p v-else class="cs-readonly">
        <span v-if="setup.short_code" class="cs-chip">{{ setup.short_code }}</span>
        <span v-else class="cs-muted">{{ $t('my_club.setup.code_none') }}</span>
        <span class="cs-muted">{{ $t('my_club.setup.code_federation') }}</span>
      </p>
    </div>
  </section>
</template>

<style scoped>
.club-setup { display: flex; flex-direction: column; gap: var(--space-4); }
.cs-title { font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.cs-block { display: flex; flex-direction: column; gap: var(--space-2); }
.cs-label { font-size: var(--text-sm); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.cs-hint { margin: 0; font-size: var(--text-xs); color: var(--fg-3); line-height: 1.5; max-width: 60ch; }
.cs-row { display: flex; gap: var(--space-2); align-items: center; }
.cs-url { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--text-xs); }
.cs-code { width: 9rem; text-transform: uppercase; font-family: var(--font-mono); }
/* The code itself is shown upper case, the "e.g." in the placeholder isn't. */
.cs-code::placeholder { text-transform: none; }
.cs-readonly { margin: 0; display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.cs-chip {
  font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 600;
  padding: 2px var(--space-2); border-radius: var(--radius-sm);
  background: var(--accent-soft); color: var(--accent);
}
.cs-muted { font-size: var(--text-xs); color: var(--fg-3); }
@media (max-width: 720px) {
  .cs-row { flex-direction: column; align-items: stretch; }
  .cs-code { width: 100%; }
}
</style>
