<script setup>
// Junior divers waiting for this person to confirm them, and parents added
// to an existing junior (routes/juniors.js GET /api/juniors/pending). The
// server only sends what the caller decides, on the same ladder as diver
// requests (lib/juniors.js), so this lists and posts.
//
// A junior is confirmed through /api/juniors/:id/review; a parent link is
// a guardians row and goes through the guardian review route like any
// other, which is where its rules live.
//
// Used on My club, My region and User Manager. hideWhenEmpty keeps User
// Manager's request area from growing an empty block.
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import EmptyState from '@/components/EmptyState.vue'
import LoadError from '@/components/LoadError.vue'

const props = defineProps({
  showClub: { type: Boolean, default: false },
  hideWhenEmpty: { type: Boolean, default: false },
  // A heading of its own, for a page where the queue may hide itself.
  title: { type: String, default: '' },
})
// How many are waiting, after every load and decision, for a page that
// counts them (User Manager's Pending tab).
const emit = defineEmits(['count'])

const { t } = useI18n()
const auth = useAuthStore()
const juniors = ref([])
const links = ref([])
const loading = ref(true)
const loadError = ref(false)
const busyId = ref(null)

const empty = computed(() => !juniors.value.length && !links.value.length)
watch(() => juniors.value.length + links.value.length, (n) => emit('count', n))
const hidden = computed(() => props.hideWhenEmpty && !loading.value && !loadError.value && empty.value)

function addedBy(j) {
  const who = j.added_by?.full_name || j.added_by?.username || '?'
  return t(`juniors.added_as_${j.created_as}`, { name: who })
}

async function load() {
  loading.value = true
  loadError.value = false
  try {
    const out = await auth.apiFetch('/api/juniors/pending')
    juniors.value = out?.juniors || []
    links.value = out?.parent_links || []
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

async function decide(kind, row, decision) {
  busyId.value = row.id
  const url = kind === 'junior'
    ? `/api/juniors/${row.id}/review`
    : `/api/guardian-requests/${row.id}/review`
  const list = kind === 'junior' ? juniors : links
  try {
    await auth.apiFetch(url, { method: 'POST', body: JSON.stringify({ decision }) })
    list.value = list.value.filter(r => r.id !== row.id)
  } catch (err) {
    // 409: somebody else decided it first, so it's settled either way.
    if (err.status === 409) list.value = list.value.filter(r => r.id !== row.id)
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

// "Same child": a pending junior that's a diver the club already has under
// another spelling. The adder is linked to that profile and this one goes
// (POST /api/juniors/:id/merge), so a parent never has to track down who
// runs the club to get linked.
async function merge(j, d) {
  if (!await confirmAction({
    title: t('juniors.merge_title', { name: d.full_name }),
    body: t('juniors.merge_body', { adder: j.added_by?.full_name || j.added_by?.username || '?', name: d.full_name }),
    confirmLabel: t('juniors.merge_confirm'),
    cancelLabel: t('common.cancel'),
  })) return
  busyId.value = j.id
  try {
    await auth.apiFetch(`/api/juniors/${j.id}/merge`, { method: 'POST', body: JSON.stringify({ into: d.id }) })
    juniors.value = juniors.value.filter(r => r.id !== j.id)
    showSuccess(t('juniors.merged', { name: d.full_name }))
  } catch (err) {
    if (err.status === 409) juniors.value = juniors.value.filter(r => r.id !== j.id)
    showError(err.message)
  } finally {
    busyId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div v-if="!hidden" class="jq" data-testid="junior-queue">
    <div v-if="title" class="jq-title">{{ title }}</div>
    <div v-if="loading" class="muted">…</div>
    <LoadError v-else-if="loadError" @retry="load" />
    <EmptyState
      v-else-if="empty"
      icon="✓"
      :title="$t('juniors.queue_empty_title')"
      :body="$t('juniors.queue_empty_body')"
    />
    <template v-else>
      <p class="muted">{{ $t('juniors.queue_hint') }}</p>
      <ul class="rows">
        <li v-for="j in juniors" :key="j.id" class="row card-sm" data-testid="junior-queue-row">
          <div class="who">
            <span class="name">{{ j.full_name }}</span>
            <span class="meta">
              <template v-if="j.age != null">{{ $t('guardians.age_years', { age: j.age }) }}</template>
              <template v-if="j.gender"> · {{ $t(`juniors.gender_${j.gender}`) }}</template>
              <template v-if="showClub && j.club_name"> · {{ j.club_name }}</template>
            </span>
            <span class="meta">{{ addedBy(j) }}<template v-if="j.added_by?.username"> (@{{ j.added_by.username }})</template></span>
            <span v-for="d in j.duplicates || []" :key="d.id" class="dup" data-testid="junior-queue-duplicate">
              <span class="warn">{{ $t('juniors.queue_duplicate_of', { name: d.full_name }) }}</span>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="busyId === j.id"
                      @click="merge(j, d)">{{ $t('juniors.queue_same_child') }}</button>
            </span>
          </div>
          <div class="actions">
            <button class="btn btn-ghost btn-sm" :disabled="busyId === j.id"
                    @click="decide('junior', j, 'rejected')">{{ $t('juniors.turn_down') }}</button>
            <button class="btn btn-primary btn-sm" :disabled="busyId === j.id"
                    @click="decide('junior', j, 'approved')">{{ $t('juniors.confirm') }}</button>
          </div>
        </li>
        <li v-for="l in links" :key="l.id" class="row card-sm" data-testid="junior-parent-row">
          <div class="who">
            <span class="name">{{ $t('juniors.queue_parent_link', { parent: l.parent.full_name, child: l.junior_name }) }}</span>
            <span class="meta">
              @{{ l.parent.username }}
              <template v-if="l.age != null"> · {{ $t('guardians.age_years', { age: l.age }) }}</template>
              <template v-if="showClub && l.club_name"> · {{ l.club_name }}</template>
            </span>
          </div>
          <div class="actions">
            <button class="btn btn-ghost btn-sm" :disabled="busyId === l.id"
                    @click="decide('link', l, 'rejected')">{{ $t('juniors.turn_down') }}</button>
            <button class="btn btn-primary btn-sm" :disabled="busyId === l.id"
                    @click="decide('link', l, 'approved')">{{ $t('juniors.confirm') }}</button>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.jq { display: flex; flex-direction: column; gap: var(--space-2); }
/* Matches User Manager's other request headings (.club-requests-head). */
.jq-title {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  padding: 0 0.5rem;
}
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
.meta { font-size: var(--text-xs); color: var(--fg-3); }
.warn { font-size: var(--text-xs); color: var(--warn-fg); font-weight: 600; }
.dup { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: 2px; }
.actions { display: flex; gap: var(--space-2); flex-shrink: 0; }
.muted { color: var(--fg-3); font-size: var(--text-sm); margin: 0; max-width: 64ch; }
@media (max-width: 720px) {
  .row { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-end; }
}
</style>
