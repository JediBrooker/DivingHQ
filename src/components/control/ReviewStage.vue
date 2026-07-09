<script setup>
// ReviewStage (P8): a Completed event's final standings + recap, read
// from /api/scoreboard/:id (the same source V1's leaderboard uses). The
// operator's deeper review stays on the public scoreboard (linked).
// Drawer's broadcast/exports relocation is a later slice.
import { ref, watch, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({ event: { type: Object, required: true } })
const auth = useAuthStore()

const standings = ref([])
const loading = ref(false)
const error = ref('')

function fmtTotal(s) {
  const v = s.total ?? s.total_points
  return v != null ? Number(v).toFixed(2) : '—'
}

async function load() {
  if (!props.event?.id) return
  loading.value = true
  error.value = ''
  try {
    const data = await auth.apiFetch(`/api/scoreboard/${props.event.id}`)
    standings.value = Array.isArray(data?.standings) ? data.standings : []
  } catch (err) {
    error.value = err?.message || 'Failed to load results'
    standings.value = []
  } finally {
    loading.value = false
  }
}

watch(() => props.event?.id, load, { immediate: true })
defineExpose({ reload: load })

const top = computed(() => standings.value.slice(0, 8))
</script>

<template>
  <div class="review-stage">
    <div class="review-head">
      <span class="review-badge">Completed</span>
      <RouterLink :to="`/scoreboard/${event.id}`" class="review-link">Open public scoreboard →</RouterLink>
    </div>
    <p v-if="loading" class="review-msg">Loading results…</p>
    <p v-else-if="error" class="review-msg review-error">{{ error }}</p>
    <p v-else-if="!standings.length" class="review-msg">No standings yet.</p>
    <ol v-else class="review-standings" aria-label="Final standings">
      <li v-for="s in top" :key="s.competitor_id || s.full_name" class="review-row">
        <span class="review-rank">{{ s.rank }}</span>
        <span class="review-name">
          {{ s.full_name }}
          <span v-if="s.country_code" class="review-country">{{ s.country_code }}</span>
        </span>
        <span class="review-total">{{ fmtTotal(s) }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.review-head { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
.review-badge {
  font-family: var(--font-display); font-size: 11px; font-weight: 800; letter-spacing: 0.12em;
  padding: 0.2rem 0.6rem; border-radius: 999px; color: var(--green); background: rgba(16, 185, 129, 0.12);
}
.review-link { font-family: var(--font-mono); font-size: 12px; color: var(--cyan); text-decoration: none; }
.review-link:hover { text-decoration: underline; }
.review-standings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.review-row {
  display: flex; align-items: center; gap: 0.85rem;
  padding: 0.55rem 0.85rem; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-3);
}
.review-rank {
  font-family: var(--font-display); font-size: 18px; font-weight: 900; width: 32px; text-align: end;
  color: var(--text-3); flex-shrink: 0;
}
.review-name { flex: 1; font-family: var(--font-display); font-weight: 700; color: var(--fg); font-size: 14px; }
.review-country { font-family: var(--font-mono); font-size: 11px; font-weight: 400; color: var(--text-3); margin-inline-start: 0.4rem; }
.review-total { font-family: var(--font-mono); font-size: 16px; color: var(--cyan); flex-shrink: 0; }
.review-msg { padding: 2rem; text-align: center; color: var(--text-3); font-family: var(--font-mono); }
.review-error { color: var(--red); }
</style>
