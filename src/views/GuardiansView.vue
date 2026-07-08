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
  <div class="guardians-view">
    <h2>{{ t('guardians.title') }}</h2>
    <p class="muted">{{ t('guardians.subtitle') }}</p>

    <div v-if="loading" class="muted">...</div>

    <template v-else>
      <p v-if="!dependents.length" class="muted">{{ t('guardians.empty') }}</p>

      <div v-for="dep in dependents" :key="dep.guardian_link_id" class="dep-card">
        <div class="dep-info">
          <span class="dep-name">{{ dep.full_name }}</span>
          <span v-if="dep.date_of_birth" class="dep-age">
            {{ t('guardians.age_years', { age: ageFromDob(dep.date_of_birth) }) }}
          </span>
        </div>
        <button class="btn" @click="revoke(dep)">{{ t('guardians.revoke') }}</button>
      </div>
    </template>

    <div class="link-section">
      <h3>{{ t('guardians.add') }}</h3>
      <input
        v-model="searchQuery"
        type="text"
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
  </div>
</template>

<style scoped>
.guardians-view {
  max-width: 600px;
}
.dep-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  border: 1px solid var(--border, #ddd);
  border-radius: 0.5rem;
  margin-bottom: 0.5rem;
}
.dep-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.dep-name {
  font-weight: 600;
}
.dep-age {
  font-size: 0.85rem;
  color: var(--muted, #777);
}
.search-results {
  border: 1px solid var(--border, #ddd);
  border-radius: 0.5rem;
  max-height: 200px;
  overflow-y: auto;
}
.search-item {
  padding: 0.5rem 0.75rem;
  cursor: pointer;
}
.search-item:hover {
  background: var(--bg-2, #f5f5f5);
}
.link-section {
  margin-top: 1.5rem;
}
.muted {
  color: var(--muted, #777);
}
</style>
