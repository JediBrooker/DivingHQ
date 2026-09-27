<script setup>
// Who admins a region (state, province...). Opened from the Clubs
// screen by the federation's org_admin or a sysadmin; the server
// enforces the same. Candidates are members of the region's clubs.
import { ref, computed, onMounted } from 'vue'
import BaseModal from '@/components/BaseModal.vue'
import ModalHeader from '@/components/control/ModalHeader.vue'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'

const props = defineProps({
  region: { type: Object, required: true },   // { id, name }
})
defineEmits(['close'])

const auth = useAuthStore()
const admins = ref([])
const candidates = ref([])
const loading = ref(true)
const busy = ref(false)
const toAdd = ref('')

const addable = computed(() => {
  const taken = new Set(admins.value.map(a => a.id))
  return candidates.value.filter(m => !taken.has(m.id))
})

async function load() {
  loading.value = true
  try {
    const body = await auth.apiFetch(`/api/regions/${props.region.id}/admins`)
    admins.value = body.admins || []
    candidates.value = body.candidates || []
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
    await auth.apiFetch(`/api/regions/${props.region.id}/admins`, {
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
    await auth.apiFetch(`/api/regions/${props.region.id}/admins/${admin.id}`, { method: 'DELETE' })
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
      <ModalHeader :title-id="titleId" title="Region admins" :subtitle="region.name" @close="$emit('close')" />
      <div class="lb-body">
        <p class="hint-line intro">
          Region admins run meets their region or its clubs host, and review
          role requests from the region's clubs.
        </p>

        <div class="section-label">Current admins ({{ admins.length }})</div>
        <div v-if="loading" class="empty">Loading…</div>
        <ul v-else-if="admins.length" class="admin-list">
          <li v-for="a in admins" :key="a.id" class="admin-row">
            <span class="admin-name">{{ a.full_name }} <span class="admin-user">@{{ a.username }}</span></span>
            <button class="btn btn-danger btn-sm" :disabled="busy" @click="remove(a)">Remove</button>
          </li>
        </ul>
        <div v-else class="empty">Nobody admins this region yet.</div>

        <div class="section-label" style="margin-top:1.25rem">Add an admin</div>
        <div class="add-row">
          <select class="select" v-model="toAdd" :disabled="loading || !addable.length">
            <option value="">— Pick a member of this region's clubs —</option>
            <option v-for="m in addable" :key="m.id" :value="m.id">
              {{ m.full_name }} (@{{ m.username }}) · {{ m.club_name }}
            </option>
          </select>
          <button class="btn btn-primary btn-sm" :disabled="!toAdd || busy" @click="add">Add</button>
        </div>
        <p v-if="!loading && !addable.length" class="hint-line">
          No one to add yet. Put clubs in this region first, their members show up here.
        </p>
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
