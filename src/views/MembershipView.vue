<script setup>
// Diver-facing membership page (/membership). Shows what membership costs
// per tier, with a real Pay action once payments go live (until then the
// card just shows its own coming-soon note). Each card reads the resolved
// price from the diver-facing GET /api/orgs/:orgId/membership endpoint.
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import FeePreviewCard from '@/components/payments/FeePreviewCard.vue'
import SubjectSelector from '@/components/payments/SubjectSelector.vue'

const auth = useAuthStore()
const orgId = computed(() => auth.user?.org_id)
const payingFor = ref('')

const TIERS = [
  { key: '', label: 'Standard' },
  { key: 'junior', label: 'Junior' },
  { key: 'senior', label: 'Senior' },
  { key: 'masters', label: 'Masters' },
]
</script>

<template>
  <section class="membership-view">
    <h1>Membership</h1>
    <p class="lede">
      Membership unlocks members-only entry prices. It isn't required to enter
      competitions.
    </p>
    <SubjectSelector v-model="payingFor" />
    <div class="tiers" v-if="orgId">
      <div v-for="tr in TIERS" :key="tr.key" class="tier-card">
        <h3>{{ tr.label }}</h3>
        <FeePreviewCard
          :title="`${tr.label} membership`"
          :load-url="`/api/orgs/${orgId}/membership?tier=${tr.key}`"
          :checkout-url="`/api/orgs/${orgId}/membership/checkout`"
          :checkout-body="tr.key ? { tier: tr.key } : {}"
          :subject-user-id="payingFor"
          coming-soon-message="Membership payments are coming soon."
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.membership-view { display: flex; flex-direction: column; gap: 1rem; max-width: 60rem; margin: 0 auto; padding: 1rem; }
.lede { color: var(--muted, #777); margin: 0; }
.tiers { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
.tier-card { border: 1px solid var(--border, #ddd); border-radius: .75rem; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: .5rem; }
.tier-card h3 { margin: 0; }
</style>
