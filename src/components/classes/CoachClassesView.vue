<script setup>
// Coach: read-only view of who's enrolled in their club's classes.
// Backed by /api/coach/classes (scoped server-side to the coach's own
// users.club_id — a coach can never see another club's roster).
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import { GraduationCap } from '@lucide/vue'

const auth = useAuthStore()
const { t } = useI18n()

const loading = ref(true)
const classes = ref([])

onMounted(async () => {
  try {
    classes.value = await auth.apiFetch('/api/coach/classes')
  } catch (e) {
    showError(e.message || t('classes.error_load'))
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="coach-classes">
    <p class="muted">{{ t('classes.coach_hint') }}</p>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="!classes.length" class="muted empty">
      <GraduationCap class="empty-ic" />
      {{ t('classes.coach_no_classes') }}
    </p>
    <div v-else class="class-list">
      <div v-for="cls in classes" :key="cls.id" class="class-card">
        <div class="class-name">{{ cls.name }}</div>
        <div class="class-meta">
          <span v-if="cls.level">{{ cls.level }}</span>
          <span v-if="cls.schedule">{{ cls.schedule }}</span>
        </div>
        <p v-if="!cls.enrolments.length" class="muted small">{{ t('classes.roster_empty') }}</p>
        <ul v-else class="roster-list">
          <li v-for="e in cls.enrolments" :key="e.diver_id">
            {{ e.diver_name }}
            <span v-if="e.status === 'pending'" class="pill pending">{{ t('classes.status_pending') }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.coach-classes { display: flex; flex-direction: column; gap: 1rem; }
.muted { color: var(--muted, #777); margin: 0; }
.small { font-size: .82rem; }
.empty { display: flex; align-items: center; gap: .5rem; padding: 1.5rem 0; justify-content: center; }
.empty-ic { width: 22px; height: 22px; }
.class-list { display: flex; flex-direction: column; gap: .6rem; }
.class-card { border: 1px solid var(--border, #ddd); border-radius: var(--radius-lg, .75rem); padding: .85rem 1rem; }
.class-name { font-weight: 600; }
.class-meta { display: flex; gap: .75rem; flex-wrap: wrap; font-size: .82rem; color: var(--muted, #777); margin: .2rem 0 .5rem; }
.roster-list { margin: 0; padding-left: 1.1rem; display: flex; flex-direction: column; gap: .25rem; font-size: .88rem; }
.pill { padding: .05rem .45rem; border-radius: 999px; font-size: .7rem; margin-left: .4rem; background: var(--bg-2, #eee); color: var(--amber, #b70); }
</style>
