<script setup>
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess, showError } from '@/composables/useNotify'
import { useI18n } from 'vue-i18n'

const auth = useAuthStore()
const { t } = useI18n()

const dependents = ref([])
const loading = ref(true)

const searchQuery = ref('')
const searchResults = ref([])
let searchTimer = null

function ageFromDob(dob) {
  if (!dob) return null
  const birth = new Date(dob)
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const m = now.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--
  return age
}

async function loadDependents() {
  loading.value = true
  try {
    const data = await auth.apiFetch('/api/guardians/my-dependents')
    dependents.value = data.dependents || data || []
  } catch (e) {
    showError(e.message || 'Failed to load dependents')
  } finally {
    loading.value = false
  }
}

async function revoke(link) {
  if (!confirm(t('guardians.revoke_confirm'))) return
  try {
    await auth.apiFetch(`/api/guardians/${link.guardian_link_id}/revoke`, { method: 'POST' })
    showSuccess(t('guardians.revoke'))
    await loadDependents()
  } catch (e) {
    showError(e.message || 'Revoke failed')
  }
}

function onSearchInput() {
  clearTimeout(searchTimer)
  const q = searchQuery.value.trim()
  if (!q) { searchResults.value = []; return }
  searchTimer = setTimeout(() => searchUsers(q), 300)
}

async function searchUsers(q) {
  try {
    const data = await auth.apiFetch(`/api/users?search=${encodeURIComponent(q)}`)
    const rows = data.users || data || []
    searchResults.value = rows.filter(u => u.id !== auth.user?.id)
  } catch (e) {
    showError(e.message || 'Search failed')
  }
}

async function requestLink(user) {
  try {
    await auth.apiFetch('/api/guardians/request', {
      method: 'POST',
      body: JSON.stringify({ dependent_user_id: user.id }),
    })
    showSuccess(t('guardians.request_sent'))
    searchQuery.value = ''
    searchResults.value = []
  } catch (e) {
    showError(e.message || 'Request failed')
  }
}

onMounted(loadDependents)
</script>

<template>
  <section class="guardians-view">
    <h1>{{ t('guardians.title') }}</h1>
    <p class="muted">{{ t('guardians.subtitle') }}</p>

    <p v-if="loading" class="muted">...</p>

    <template v-else>
      <p v-if="!dependents.length" class="muted">{{ t('guardians.empty') }}</p>

      <div v-for="dep in dependents" :key="dep.guardian_link_id" class="dep-card">
        <div class="dep-main">
          <div class="dep-name">{{ dep.full_name }}</div>
          <div v-if="dep.date_of_birth" class="dep-age">
            {{ t('guardians.age_years', { age: ageFromDob(dep.date_of_birth) }) }}
          </div>
        </div>
        <button class="btn-revoke" @click="revoke(dep)">{{ t('guardians.revoke') }}</button>
      </div>
    </template>

    <div class="link-section">
      <h2 class="section-h">{{ t('guardians.add') }}</h2>
      <input
        v-model="searchQuery"
        type="text"
        class="search-input"
        :placeholder="t('guardians.search_placeholder')"
        @input="onSearchInput"
      />
      <div v-if="searchResults.length" class="search-results">
        <div
          v-for="u in searchResults"
          :key="u.id"
          class="search-item"
          @click="requestLink(u)"
        >
          {{ u.full_name }}
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.guardians-view { display: flex; flex-direction: column; gap: 1rem; max-width: 50rem; margin: 0 auto; padding: 1rem; }
.guardians-view h1 { margin: 0 0 .25rem; }
.muted { color: var(--muted, #777); margin: 0; }
.dep-card {
  display: flex; align-items: center; gap: 1rem;
  border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: .85rem 1rem;
}
.dep-main { flex: 1; min-width: 0; }
.dep-name { font-weight: 600; }
.dep-age { font-size: .85rem; color: var(--muted, #777); }
.btn-revoke {
  padding: .45rem .8rem; border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem);
  background: transparent; color: var(--fg-2, #555); cursor: pointer; font: inherit; font-size: .88rem;
}
.btn-revoke:hover { background: var(--surface-hover, #f5f5f5); }
.link-section { margin-top: .5rem; }
.section-h { font-size: 1rem; margin: .5rem 0 .5rem; }
.search-input {
  width: 100%; padding: .55rem .75rem;
  border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem);
  background: var(--surface, #fff); color: var(--fg, #111); font: inherit; font-size: .9rem;
}
.search-input::placeholder { color: var(--muted, #999); }
.search-results {
  border: 1px solid var(--border, #ddd); border-radius: var(--radius, .5rem);
  max-height: 200px; overflow-y: auto; margin-top: .35rem;
}
.search-item { padding: .55rem .75rem; cursor: pointer; font-size: .9rem; }
.search-item:hover { background: var(--bg-2, #f5f5f5); }
</style>
