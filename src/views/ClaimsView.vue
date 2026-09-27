<script setup>
// Claims (phase 3, lib/claims.js): a federation or state body asking to
// take over an account the clubs started. Everyone lands on the same
// page and sees what they can act on: club / region admins vote, a
// federation decides claims on its regions, the sysadmin decides
// escalations and can revoke. Claimants see their own claim's progress.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import { fmtDate } from '@/lib/format'
import EmptyState from '@/components/EmptyState.vue'

const { t } = useI18n()
const auth = useAuthStore()

const claims = ref([])
const loading = ref(true)
const busyId = ref(null)
// Per claim: which of my clubs is voting, and the objection being typed.
const draft = ref({})

const actionable = computed(() => claims.value.filter(c => c.can_vote || c.can_decide))
const others = computed(() => claims.value.filter(c => !c.can_vote && !c.can_decide))

function d(c) {
  if (!draft.value[c.id]) {
    const open = c.my_votes.filter(v => !v.vote)
    draft.value[c.id] = { voterId: open[0]?.voter_id || '', objecting: false, reason: '' }
  }
  return draft.value[c.id]
}

function statusLabel(c) {
  if (c.status === 'open' && !c.activated) return t('claims.awaiting_email')
  return t(`claims.status_${c.status}`)
}

async function load() {
  loading.value = true
  try {
    claims.value = await auth.apiFetch('/api/claims')
  } catch (err) {
    showError(err.message)
  } finally {
    loading.value = false
  }
}

async function post(c, path, body) {
  busyId.value = c.id
  try {
    await auth.apiFetch(`/api/claims/${c.id}/${path}`, { method: 'POST', body: JSON.stringify(body) })
    delete draft.value[c.id]
    await load()
    return true
  } catch (err) {
    showError(err.message)
    return false
  } finally {
    busyId.value = null
  }
}

function vote(c, v) {
  const st = d(c)
  return post(c, 'vote', { vote: v, reason: v === 'object' ? st.reason : undefined, voter_id: st.voterId || undefined })
}

async function decide(c, decision) {
  if (decision === 'reject' && !await confirmAction({
    title: t('claims.reject'), body: c.body_name, confirmLabel: t('claims.reject'), confirmKind: 'danger',
  })) return
  if (await post(c, 'decide', { decision })) showSuccess(t(`claims.status_${decision === 'approve' ? 'approved' : 'rejected'}`))
}

async function revoke(c) {
  if (!await confirmAction({
    title: t('claims.revoke'), body: t('claims.revoke_body', { body: c.body_name, target: c.target_name }),
    confirmLabel: t('claims.revoke'), confirmKind: 'danger',
  })) return
  await post(c, 'revoke', {})
}

onMounted(load)
</script>

<template>
  <div class="main">
    <header>
      <h1 class="title">{{ $t('claims.title') }}</h1>
      <p class="intro">{{ $t('claims.intro') }}</p>
    </header>

    <div v-if="loading" class="muted">…</div>
    <EmptyState v-else-if="!claims.length" icon="⚖" :title="$t('claims.empty_title')" :body="$t('claims.empty_body')" />

    <template v-else>
      <section v-for="group in [actionable, others]" :key="group === actionable ? 'a' : 'b'" v-show="group.length" class="list">
        <article v-for="c in group" :key="c.id" class="claim card">
          <div class="claim-head">
            <div>
              <div class="claim-title">{{ c.body_name }} <span class="arrow">→</span> {{ c.target_name }}</div>
              <div class="meta">
                {{ c.target_kind === 'org' ? $t('claims.kind_org') : $t('claims.kind_region') }}
                <template v-if="c.target_kind === 'region'"> · {{ c.org_name }}</template>
                · {{ $t('claims.by', { name: c.claimant_name }) }}
              </div>
            </div>
            <span class="status" :data-status="c.activated ? c.status : 'pending'">{{ statusLabel(c) }}</span>
          </div>

          <ul class="facts">
            <li>{{ $t(`claims.approver_${c.approver}`) }}</li>
            <li v-if="['clubs', 'regions'].includes(c.approver)">
              {{ $t('claims.tally', { approvals: c.tally.approvals, eligible: c.tally.eligible, objections: c.tally.objections }) }}
            </li>
            <li v-if="c.status === 'open' && c.closes_at">{{ $t('claims.closes', { date: fmtDate(c.closes_at) }) }}</li>
            <li v-if="c.website">
              <a :href="/^https?:/i.test(c.website) ? c.website : `https://${c.website}`" target="_blank" rel="noopener noreferrer">{{ c.website }}</a>
              <span v-if="c.domain_verified" class="badge">✓ {{ $t('claims.domain_verified') }}</span>
            </li>
            <li v-if="c.status_reason">{{ c.status_reason }}</li>
          </ul>

          <div v-if="c.objections.length" class="objections">
            <div class="label">{{ $t('claims.objections') }}</div>
            <p v-for="(o, i) in c.objections" :key="i">“{{ o }}”</p>
          </div>

          <p v-for="v in c.my_votes.filter(v => v.vote)" :key="v.voter_id" class="voted">
            {{ $t(v.vote === 'approve' ? 'claims.voted_approve' : 'claims.voted_object', { club: v.name }) }}
          </p>

          <!-- Vote -->
          <div v-if="c.can_vote" class="actions">
            <label v-if="c.my_votes.filter(v => !v.vote).length > 1" class="pick">
              {{ $t('claims.voting_for') }}
              <select class="select select-sm" v-model="d(c).voterId">
                <option v-for="v in c.my_votes.filter(v => !v.vote)" :key="v.voter_id" :value="v.voter_id">{{ v.name }}</option>
              </select>
            </label>
            <template v-if="!d(c).objecting">
              <button class="btn btn-ghost btn-sm" :disabled="busyId === c.id" @click="d(c).objecting = true">{{ $t('claims.object') }}</button>
              <button class="btn btn-primary btn-sm" :disabled="busyId === c.id" @click="vote(c, 'approve')">{{ $t('claims.approve') }}</button>
            </template>
            <div v-else class="objection-form">
              <textarea class="textarea" rows="2" v-model="d(c).reason" :placeholder="$t('claims.object_reason')"></textarea>
              <div class="row-end">
                <button class="btn btn-ghost btn-sm" @click="d(c).objecting = false">{{ $t('common.cancel') }}</button>
                <button class="btn btn-danger btn-sm" :disabled="busyId === c.id || !d(c).reason.trim()" @click="vote(c, 'object')">{{ $t('claims.send_objection') }}</button>
              </div>
            </div>
          </div>

          <!-- Decide (federation for its regions, or the sysadmin) -->
          <div v-if="c.can_decide" class="actions">
            <button class="btn btn-ghost btn-sm" :disabled="busyId === c.id" @click="decide(c, 'reject')">{{ $t('claims.reject') }}</button>
            <button class="btn btn-primary btn-sm" :disabled="busyId === c.id" @click="decide(c, 'approve')">{{ $t('claims.approve') }}</button>
          </div>

          <div v-if="c.can_revoke" class="actions">
            <button class="btn btn-danger btn-sm" :disabled="busyId === c.id" @click="revoke(c)">{{ $t('claims.revoke') }}</button>
          </div>
        </article>
      </section>
    </template>
  </div>
</template>

<style scoped>
.main { max-width: 880px; margin: 0 auto; padding: var(--space-6) var(--space-8); display: flex; flex-direction: column; gap: var(--space-6); }
.title { font-size: var(--text-h2); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.intro { margin: var(--space-1) 0 0; color: var(--fg-3); font-size: var(--text-sm); max-width: 60ch; }
.list { display: flex; flex-direction: column; gap: var(--space-3); }
.claim { display: flex; flex-direction: column; gap: var(--space-3); }
.claim-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); }
.claim-title { font-weight: 600; color: var(--fg); font-size: var(--text-h3); }
.arrow { color: var(--fg-3); font-weight: 400; }
.meta { font-size: var(--text-xs); color: var(--fg-3); margin-top: 2px; }
.status {
  flex-shrink: 0; font-size: var(--text-xs); font-weight: 600; padding: 2px var(--space-2);
  border-radius: var(--radius-pill); border: 1px solid var(--border); color: var(--fg-2); background: var(--surface-2);
}
.status[data-status="approved"] { color: var(--ok-fg); border-color: var(--ok-solid); background: var(--ok-bg); }
.status[data-status="open"] { color: var(--info-fg); border-color: var(--info-solid); background: var(--info-bg); }
.status[data-status="escalated"] { color: var(--warn-fg); border-color: var(--warn-solid); background: var(--warn-bg); }
.status[data-status="rejected"], .status[data-status="revoked"] { color: var(--danger-fg); border-color: var(--danger-solid); background: var(--danger-bg); }
.facts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--text-sm); color: var(--fg-2); }
.facts a { color: var(--accent); overflow-wrap: anywhere; }
.badge { margin-inline-start: var(--space-2); font-size: var(--text-xs); color: var(--fg-3); }
.objections { font-size: var(--text-sm); color: var(--fg-2); }
.objections p { margin: 2px 0 0; font-style: italic; }
.voted { margin: 0; font-size: var(--text-sm); color: var(--fg-3); }
.actions { display: flex; justify-content: flex-end; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.pick { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--fg-3); margin-inline-end: auto; }
.select-sm { padding: 0.25rem 0.4rem; font-size: 12px; }
.objection-form { flex: 1 1 100%; display: flex; flex-direction: column; gap: var(--space-2); }
.row-end { display: flex; justify-content: flex-end; gap: var(--space-2); }
.muted { color: var(--fg-3); font-size: var(--text-sm); }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .claim-head { flex-direction: column; }
}
</style>
