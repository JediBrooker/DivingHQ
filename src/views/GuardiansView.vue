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
// Set once a search for the current text has come back, so "nobody by
// that name" only shows after we've actually looked.
const searchedFor = ref('')
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
    // Pending ones too, so a request that's gone in shows as waiting
    // rather than vanishing until an admin gets to it.
    const data = await auth.apiFetch('/api/guardians/my-dependents?include_pending=1')
    dependents.value = Array.isArray(data) ? data : []
  } catch (e) {
    showError(e.message || 'Failed to load dependents')
  } finally {
    loading.value = false
  }
}

async function revoke(link) {
  const pending = link.status === 'pending'
  if (!confirm(t(pending ? 'guardians.withdraw_confirm' : 'guardians.revoke_confirm'))) return
  try {
    await auth.apiFetch(`/api/guardians/${link.guardian_link_id}/revoke`, { method: 'POST' })
    showSuccess(t(pending ? 'guardians.withdraw' : 'guardians.revoke'))
    await loadDependents()
  } catch (e) {
    showError(e.message || 'Revoke failed')
  }
}

function onSearchInput() {
  clearTimeout(searchTimer)
  const q = searchQuery.value.trim()
  if (q.length < 2) { searchResults.value = []; searchedFor.value = ''; return }
  searchTimer = setTimeout(() => searchUsers(q), 300)
}

// GET /api/users is the org admin's member list, so a parent got a 403
// here. This one is scoped to the caller's own federation and names only.
async function searchUsers(q) {
  try {
    const rows = await auth.apiFetch(`/api/guardians/search?q=${encodeURIComponent(q)}`)
    // A slow answer for an older query mustn't overwrite a newer one.
    if (q !== searchQuery.value.trim()) return
    searchResults.value = Array.isArray(rows) ? rows : []
    searchedFor.value = q
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
    searchedFor.value = ''
    await loadDependents()
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

        <div v-for="dep in dependents" :key="dep.guardian_link_id" class="gv-dep" data-testid="guardian-link">
          <div class="gv-dep-info">
            <span class="gv-dep-name">{{ dep.full_name }}</span>
            <span v-if="dep.date_of_birth" class="gv-dep-age">
              {{ t('guardians.age_years', { age: ageFromDob(dep.date_of_birth) }) }}
            </span>
          </div>
          <span v-if="dep.status === 'pending'" class="badge badge-amber">{{ t('guardians.pending_badge') }}</span>
          <button class="btn btn-ghost btn-sm" @click="revoke(dep)">
            {{ dep.status === 'pending' ? t('guardians.withdraw') : t('guardians.revoke') }}
          </button>
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
        <ul v-if="searchResults.length" class="gv-results">
          <li v-for="u in searchResults" :key="u.id">
            <button type="button" class="gv-result-item" @click="requestLink(u)">
              <span>{{ u.full_name }}</span>
              <span v-if="u.club_name" class="gv-result-club">{{ u.club_name }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="searchedFor" class="gv-no-results">{{ t('guardians.no_results') }}</p>
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
  list-style: none; margin: 0.35rem 0 0; padding: 0;
  border: 1px solid var(--border); border-radius: var(--radius);
  max-height: 220px; overflow-y: auto;
  background: var(--surface);
}
.gv-results li:not(:last-child) { border-bottom: 1px solid var(--border); }
/* Real buttons, so the list works from the keyboard. */
.gv-result-item {
  display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: 0.75rem;
  padding: 0.6rem 0.85rem; cursor: pointer; text-align: start;
  background: none; border: 0; font: inherit;
  font-size: var(--text-body); color: var(--text-2);
  transition: background var(--dur) var(--ease);
}
.gv-result-item:hover { background: var(--surface-hover); }
.gv-result-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.gv-result-club { font-size: var(--text-sm); color: var(--text-3); }
.gv-no-results { margin-top: 0.5rem; font-size: var(--text-sm); color: var(--text-3); }
</style>
