<script setup>
// A region admin's page (migration 088): the clubs in their region, who
// runs each one, and the pending role requests from those clubs'
// members. Region admins sit one level above club admins, so they can
// act on any of these requests, not just ones whose club has no admin.
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'
import { usePlural } from '@/composables/usePlural'
import EmptyState from '@/components/EmptyState.vue'
import RoleRequestQueue from '@/components/RoleRequestQueue.vue'

const { t } = useI18n()
const { tn } = usePlural()
const auth = useAuthStore()

const regions = computed(() => auth.regionAdminOf)
// Per region id: { region, clubs, admins }
const detail = ref({})

function labelFor(key) {
  return key ? t(`regions.label.${key}`) : ''
}

async function load(region) {
  try {
    const [overview, admins] = await Promise.all([
      auth.apiFetch(`/api/regions/${region.id}/overview`),
      auth.apiFetch(`/api/regions/${region.id}/admins`),
    ])
    detail.value[region.id] = { ...overview, admins: admins.admins || [] }
  } catch (err) {
    showError(err.message)
  }
}

onMounted(() => {
  for (const r of regions.value) load(r)
})
</script>

<template>
  <div class="main">
    <header class="head">
      <div>
        <h1 class="title">{{ $t('my_region.title') }}</h1>
        <p class="intro">{{ $t('my_region.intro') }}</p>
      </div>
      <RouterLink to="/manager" class="btn btn-primary btn-sm">{{ $t('my_club.run_meets') }}</RouterLink>
    </header>

    <section class="block">
      <h2 class="block-title">{{ $t('my_club.requests') }}</h2>
      <RoleRequestQueue show-club />
    </section>

    <section v-for="r in regions" :key="r.id" class="block">
      <h2 class="block-title">
        {{ r.name }}
        <span v-if="detail[r.id]?.region?.label" class="kind">{{ labelFor(detail[r.id].region.label) }}</span>
      </h2>
      <template v-if="detail[r.id]">
        <h3 class="sub-title">{{ $t('my_region.clubs') }}</h3>
        <EmptyState
          v-if="!detail[r.id].clubs.length"
          icon="🏊"
          :title="$t('my_region.no_clubs_title')"
          :body="$t('my_region.no_clubs_body')"
        />
        <ul v-else class="rows">
          <li v-for="c in detail[r.id].clubs" :key="c.id" class="row card-sm">
            <div class="who">
              <span class="name">{{ c.name }}<template v-if="c.short_code"> · {{ c.short_code }}</template></span>
              <span class="meta">{{ tn('counts.members', c.member_count) }}</span>
            </div>
            <span class="meta admins">
              <template v-if="c.admins.length">{{ c.admins.map(a => a.full_name).join(', ') }}</template>
              <template v-else>{{ $t('my_region.no_admin') }}</template>
            </span>
          </li>
        </ul>

        <h3 class="sub-title">{{ $t('my_region.region_admins') }}</h3>
        <p class="meta">{{ detail[r.id].admins.map(a => a.full_name).join(', ') }}</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.main {
  max-width: 880px; margin: 0 auto; padding: var(--space-6) var(--space-8);
  display: flex; flex-direction: column; gap: var(--space-8);
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
.title { font-size: var(--text-h2); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; }
.intro { margin: var(--space-1) 0 0; color: var(--fg-3); font-size: var(--text-sm); max-width: 56ch; }
.block { display: flex; flex-direction: column; gap: var(--space-3); }
.block-title { font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); margin: 0; display: flex; align-items: baseline; gap: var(--space-2); }
.kind { font-size: var(--text-xs); font-weight: 500; color: var(--fg-3); text-transform: uppercase; letter-spacing: 0.08em; }
.sub-title { font-size: var(--text-sm); font-weight: 600; color: var(--fg-2); margin: var(--space-2) 0 0; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.name { font-weight: 600; color: var(--fg); }
.meta { font-size: var(--text-xs); color: var(--fg-3); margin: 0; }
.admins { text-align: end; }
@media (max-width: 720px) {
  .main { padding: var(--space-4); }
  .row { flex-direction: column; align-items: flex-start; }
  .admins { text-align: start; }
}
</style>
