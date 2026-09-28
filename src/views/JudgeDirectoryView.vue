<script setup>
// Public Judge Directory: discovery surface for the per-judge
// transparency analytics at /judge-profile/:id. Anonymous
// spectators land here, type a name (or browse by federation /
// country / club), and click through to the analytics page.
//
// The transparency stance: every score this rollup aggregates is
// already public (visible on the live scoreboard, the archived
// meet page, and the PDF score sheet). Pre-aggregating per-judge
// just makes patterns visible (bias by country, by club, by dive
// group) instead of leaving them buried in 300 rows of per-dive
// HTML. WA Article 8.4.9 is the formal channel (Referee may
// remove a judge whose judgement is unsatisfactory); this page
// gives the spectator their own evidence trail.

import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useJudgeDirectory } from '@/composables/useJudgeDirectory'

const auth = useAuthStore()

const {
  q, orgId, countryCode, offset, rows, total, loading, error, orgs,
  load, loadOrgs, applyFilters, nextPage, prevPage, pageInfo,
  clearFilters: clearDirectoryFilters,
} = useJudgeDirectory(auth, { errorText: 'Could not load directory' })

const minScores = ref(0)

function clearFilters() {
  clearDirectoryFilters()
  minScores.value = 0
}

// Client-side trim by minimum-scores threshold. Keeps the
// server query simple but still gives spectators a way to
// focus on judges with enough sample for the bias number to
// be meaningful (the deviation rollup gets noisy under ~10 dives).
const visibleRows = computed(() => {
  if (!minScores.value) return rows.value
  return rows.value.filter(r => Number(r.total_scores) >= Number(minScores.value))
})

onMounted(() => {
  loadOrgs()
  load()
})
</script>

<template>
  <div class="profile-wrap judges-directory">
    <div class="page-header">
      <div>
        <div class="page-label">{{ $t('judges_directory.title') }}</div>
        <h1 class="page-title">Public Judge Analysis</h1>
        <p class="page-sub">
          Every judge in the system, with a transparent breakdown
          of how their calls track against the panel-kept mean
          (post World Aquatics trim, PART FOUR Article 9.1.5). Click a
          judge to see their full per-country, per-club,
          per-board-height bias breakdown.
        </p>
      </div>
      <div class="header-actions">
        <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
      </div>
    </div>

    <!-- Filter bar -->
    <div class="filter-bar">
      <div class="filter-fields">
        <label class="field">
          <span class="field-label">Search</span>
          <input class="input" type="search" v-model="q" :placeholder="$t('judges_directory.search')" @keydown.enter="applyFilters">
        </label>
        <label v-if="orgs.length" class="field">
          <span class="field-label">Federation</span>
          <select class="select" v-model="orgId">
            <option value="">— Any —</option>
            <option v-for="o in orgs" :key="o.id" :value="o.id">
              {{ o.name }}<template v-if="o.country_code"> ({{ o.country_code }})</template>
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Country code</span>
          <input class="input" type="text" maxlength="3" v-model="countryCode"
                 placeholder="e.g. AUS" style="text-transform: uppercase">
        </label>
        <label class="field">
          <span class="field-label">Min scores</span>
          <input class="input" type="number" min="0" step="10" v-model.number="minScores">
        </label>
        <button class="btn btn-primary btn-sm" @click="applyFilters">Apply</button>
        <button v-if="q || orgId || countryCode || minScores"
                class="btn btn-ghost btn-sm" @click="clearFilters">Clear</button>
      </div>
      <p class="filter-hint">
        Bias numbers are most reliable above ~30 scores. Use the
        "Min scores" filter to hide judges without enough sample
        size yet.
      </p>
    </div>

    <div v-if="error" class="msg msg-error" style="margin-bottom: 1rem">{{ error }}</div>

    <div v-if="loading && !rows.length" class="empty">Loading…</div>
    <div v-else-if="!visibleRows.length" class="empty">{{ $t('judges_directory.no_judges_match') }}</div>

    <table v-else class="judges-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Federation</th>
          <th>Country</th>
          <th>Club</th>
          <th>Scores</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="j in visibleRows" :key="j.id">
          <td class="strong">{{ j.full_name }}</td>
          <td>{{ j.org_name }}</td>
          <td class="mono dim">{{ j.country_code || '—' }}</td>
          <td>
            <template v-if="j.club_name">
              {{ j.club_name }}
              <span v-if="j.club_code" class="club-code">{{ j.club_code }}</span>
            </template>
            <span v-else class="dim">—</span>
          </td>
          <td class="mono">{{ j.total_scores }}</td>
          <td>
            <RouterLink :to="`/judge-profile/${j.id}`" class="btn btn-ghost btn-sm">
              Open analysis →
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="total > rows.length" class="pager">
      <button class="btn btn-ghost btn-sm" :disabled="offset === 0" @click="prevPage">← Prev</button>
      <span class="pager-info">{{ pageInfo }}</span>
      <button class="btn btn-ghost btn-sm"
              :disabled="offset + rows.length >= total"
              @click="nextPage">Next →</button>
    </div>
  </div>
</template>

<style scoped>
.profile-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
  gap: 1rem;
}
.page-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.5rem;
}
.page-title {
  font-family: var(--font-display); font-size: 36px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.page-sub {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  margin-top: 0.6rem; max-width: 70ch; line-height: 1.5;
}

.header-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }

.filter-bar {
  margin-bottom: 1rem;
}
.filter-fields {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem;
}
.field {
  display: flex; flex-direction: column; gap: 0.25rem;
}
.field-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.filter-hint {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.4rem;
}

.empty {
  color: var(--text-3); padding: 3rem 0; text-align: center;
  font-family: var(--font-mono); font-size: 13px;
}

.judges-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono); font-size: 13px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.judges-table th {
  text-align: start; padding: 0.7rem 0.85rem;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.judges-table td {
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
}
.judges-table tr:last-child td { border-bottom: none; }
.judges-table .strong { color: var(--text); font-weight: 700; }
.judges-table .dim { color: var(--text-3); }
.club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-inline-start: 0.4rem; vertical-align: middle;
}

.pager {
  display: flex; align-items: center; justify-content: center; gap: 1rem;
  margin-top: 1rem;
}
.pager-info {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}

.msg {
  padding: 0.7rem 0.9rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 12px;
}
.msg-error {
  background: rgba(239,68,68,0.10);
  border: 1px solid rgba(239,68,68,0.4);
  color: var(--red, #ef4444);
}
</style>
