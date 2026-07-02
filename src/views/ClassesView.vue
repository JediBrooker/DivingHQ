<script setup>
// Single "Classes" section, context-adaptive: club admins manage their
// club's classes + roster, coaches see a read-only roster, divers see
// their own enrolment + can self-enrol. Club-admin-ness isn't in the
// JWT (it's a club_admins row) so we fetch it once on mount; a user who
// qualifies for more than one context gets tabs, defaulting to the most
// privileged (manage > coach > mine).
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import ClubClassesManager from '@/components/classes/ClubClassesManager.vue'
import CoachClassesView from '@/components/classes/CoachClassesView.vue'
import MyClassesView from '@/components/classes/MyClassesView.vue'
import ClubPayoutsPanel from '@/components/classes/ClubPayoutsPanel.vue'
import { Layers } from '@lucide/vue'

const auth = useAuthStore()
const { t } = useI18n()

const loading = ref(true)
const adminClubs = ref([])
const isCoach = computed(() => auth.hasRole('coach'))
const selectedClubId = ref(null)
const manageSubTab = ref('classes')

const TABS = computed(() => {
  const list = []
  if (adminClubs.value.length) list.push({ key: 'manage', label: t('classes.tab_manage') })
  if (isCoach.value) list.push({ key: 'coach', label: t('classes.tab_coach') })
  list.push({ key: 'mine', label: t('classes.tab_mine') })
  return list
})
const tab = ref('mine')

onMounted(async () => {
  try {
    adminClubs.value = await auth.apiFetch('/api/me/club-admin-clubs')
    if (adminClubs.value.length) {
      selectedClubId.value = adminClubs.value[0].id
      tab.value = 'manage'
    } else if (isCoach.value) {
      tab.value = 'coach'
    }
  } catch (e) {
    showError(e.message || t('classes.error_load'))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <section class="classes-view">
    <header class="cv-head">
      <h1><Layers class="head-ic" />{{ t('classes.title') }}</h1>
      <p class="muted">{{ t('classes.subtitle') }}</p>
    </header>

    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>

    <template v-else>
      <nav v-if="TABS.length > 1" class="tabs">
        <button v-for="tt in TABS" :key="tt.key" type="button" :class="['tab', { active: tab === tt.key }]" @click="tab = tt.key">{{ tt.label }}</button>
      </nav>

      <div v-if="tab === 'manage'" class="panel">
        <div v-if="adminClubs.length > 1" class="club-picker">
          <label>{{ t('classes.pick_club') }}</label>
          <select class="in" v-model="selectedClubId">
            <option v-for="c in adminClubs" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <nav class="subtabs">
          <button type="button" :class="['subtab', { active: manageSubTab === 'classes' }]" @click="manageSubTab = 'classes'">{{ t('classes.subtab_classes') }}</button>
          <button type="button" :class="['subtab', { active: manageSubTab === 'payouts' }]" @click="manageSubTab = 'payouts'">{{ t('classes.subtab_payouts') }}</button>
        </nav>
        <ClubClassesManager v-if="selectedClubId && manageSubTab === 'classes'" :key="'cls-' + selectedClubId" :club-id="selectedClubId" />
        <ClubPayoutsPanel v-if="selectedClubId && manageSubTab === 'payouts'" :key="'pay-' + selectedClubId" :club-id="selectedClubId" />
      </div>

      <div v-else-if="tab === 'coach'" class="panel">
        <CoachClassesView />
      </div>

      <div v-else class="panel">
        <MyClassesView />
      </div>
    </template>
  </section>
</template>

<style scoped>
.classes-view { display: flex; flex-direction: column; gap: 1.25rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.cv-head h1 { margin: 0 0 .25rem; display: flex; align-items: center; gap: .5rem; }
.head-ic { width: 22px; height: 22px; }
.cv-head .muted { margin: 0; }
.muted { color: var(--muted, #777); }
.tabs { display: flex; flex-wrap: wrap; gap: .25rem; border-bottom: 1px solid var(--border, #ddd); }
.tab { appearance: none; border: 0; background: transparent; padding: .55rem .9rem; cursor: pointer; color: var(--fg-2, #555); font: inherit; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover { color: var(--fg, #222); }
.tab.active { color: var(--accent, #3b6); border-bottom-color: var(--accent, #3b6); font-weight: 600; }
.panel { display: flex; flex-direction: column; gap: 1rem; }
.club-picker { display: flex; align-items: center; gap: .5rem; font-size: .88rem; color: var(--fg-2, #555); }
.club-picker .in { padding: .35rem .5rem; border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem); background: transparent; color: var(--fg, #222); font: inherit; }
.subtabs { display: flex; gap: .3rem; }
.subtab { appearance: none; border: 1px solid var(--border, #ddd); background: transparent; padding: .35rem .75rem; border-radius: 999px; cursor: pointer; color: var(--fg-2, #555); font: inherit; font-size: .85rem; }
.subtab.active { background: var(--accent-soft, #eef); color: var(--accent, #3b6); border-color: var(--accent, #3b6); font-weight: 600; }
</style>
