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
  <div class="gv-page">
    <div class="gv-wrap">
      <div class="gv-head">
        <h1 class="gv-title">{{ t('guardians.title') }}</h1>
        <p class="gv-sub">{{ t('guardians.subtitle') }}</p>
      </div>

      <p v-if="loading" class="gv-empty">...</p>

      <template v-else>
        <div v-if="!dependents.length" class="gv-empty">
          {{ t('guardians.empty') }}
        </div>

        <div v-for="dep in dependents" :key="dep.guardian_link_id" class="gv-dep">
          <div class="gv-dep-info">
            <span class="gv-dep-name">{{ dep.full_name }}</span>
            <span v-if="dep.date_of_birth" class="gv-dep-age">
              {{ t('guardians.age_years', { age: ageFromDob(dep.date_of_birth) }) }}
            </span>
          </div>
          <button class="btn btn-ghost btn-sm" @click="revoke(dep)">{{ t('guardians.revoke') }}</button>
        </div>
      </template>

      <div class="gv-link-section">
        <label class="field">
          <span class="label">{{ t('guardians.add') }}</span>
          <input
            v-model="searchQuery"
            type="text"
            class="input"
            :placeholder="t('guardians.search_placeholder')"
            @input="onSearchInput"
          />
        </label>
        <div v-if="searchResults.length" class="gv-results">
          <div
            v-for="u in searchResults"
            :key="u.id"
            class="gv-result-item"
            @click="requestLink(u)"
          >
            {{ u.full_name }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gv-page { min-height: 100%; background: var(--bg); }
.gv-wrap { max-width: 600px; margin: 0 auto; padding: 1.75rem 1.5rem 2.5rem; }

.gv-head { margin-bottom: 1.25rem; }
.gv-title {
  font-size: var(--text-h1); font-weight: 700; color: var(--text);
  letter-spacing: var(--ls-h1); line-height: var(--lh-h1);
}
.gv-sub {
  margin-top: 0.4rem; font-size: var(--text-sm); color: var(--text-3);
  line-height: var(--lh-sm);
}

.gv-empty {
  color: var(--text-3); font-size: var(--text-sm); line-height: var(--lh-sm);
  padding: 2.25rem 1rem; text-align: center;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: var(--radius);
}

.gv-dep {
  display: flex; align-items: center; gap: 1rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 0.85rem 1rem;
  margin-bottom: 0.5rem;
}
.gv-dep-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
.gv-dep-name { font-weight: 600; color: var(--text); }
.gv-dep-age { font-size: var(--text-sm); color: var(--text-3); }

.gv-link-section { margin-top: 1.25rem; }

.gv-results {
  border: 1px solid var(--border); border-radius: var(--radius);
  max-height: 220px; overflow-y: auto; margin-top: 0.35rem;
  background: var(--surface);
}
.gv-result-item {
  padding: 0.6rem 0.85rem; cursor: pointer;
  font-size: var(--text-body); color: var(--text-2);
  transition: background var(--dur) var(--ease);
}
.gv-result-item:hover { background: var(--surface-hover); }
.gv-result-item:not(:last-child) { border-bottom: 1px solid var(--border); }
</style>
