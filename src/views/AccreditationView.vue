<script setup>
// Official/coach-facing accreditation page (/accreditation). Shows what
// accreditation costs for each official role the signed-in user holds, with
// a contextual "coming soon" preview until online payments are switched on.
// Each card reads the resolved price + status from the official-facing
// GET /api/orgs/:orgId/official-accreditation endpoint.
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import FeePreviewCard from '@/components/payments/FeePreviewCard.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)

const ROLE_LABELS = { judge: 'Judge', referee: 'Referee', coach: 'Coach', meet_manager: 'Meet manager' }
const myRoles = computed(() => (auth.user?.org_roles || []).filter(r => Object.prototype.hasOwnProperty.call(ROLE_LABELS, r)))
</script>

<template>
  <section class="accreditation-view">
    <h1>Accreditation</h1>
    <p class="lede">Annual accreditation for the official and coaching roles you hold.</p>
    <div v-if="orgId && myRoles.length" class="roles">
      <div v-for="role in myRoles" :key="role" class="role-card">
        <h3>{{ ROLE_LABELS[role] }}</h3>
        <FeePreviewCard
          :title="`${ROLE_LABELS[role]} accreditation`"
          :load-url="`/api/orgs/${orgId}/official-accreditation?role_type=${role}`"
          :checkout-url="`/api/orgs/${orgId}/official-accreditation/checkout?role_type=${role}`"
          coming-soon-message="Accreditation payments are coming soon."
        />
      </div>
    </div>
    <p v-else class="muted">You don't hold any official or coaching roles that require accreditation.</p>
  </section>
</template>

<style scoped>
.accreditation-view { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.lede { color: var(--muted, #777); margin: 0; }
.roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
.role-card { border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .5rem; }
.role-card h3 { margin: 0; }
.muted { color: var(--muted, #777); }
</style>
