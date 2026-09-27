<script setup>
// "Get started" checklist for club admins, above the dashboard tabs.
//
// A founder who signs up in a country with no federation lands on a
// dashboard built for federations: the setup wizard is org-admin only and
// their only tab is "Other". This gives them the four things that make a
// club usable, each linking to where it's done:
//
//   create a meet   /manager         ticked once the club hosts one
//   invite members  /club (link)     ticked once someone besides you joins
//   set the code    /club (code)     ticked once it has one; hidden when the
//                                    federation owns the code and hasn't set it
//   read the guide  /guide           ticked once they've opened it from here
//
// The counts come from GET /api/clubs/:id/setup, one small query. Someone
// who admins more than one club gets the first one's list; that's rare and
// the other clubs sit on My club anyway.
//
// Hiding it is per user and per browser (localStorage). It's a nudge, not
// state anyone else needs, and it costs nothing if it shows up again on a
// new device.
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { Check, X } from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const club = computed(() => auth.clubAdminOf[0] || null)
const keyFor = (what) => `dashboard.gettingStarted.${what}.v1:${auth.user?.id || ''}`

function readFlag(what) {
  try { return localStorage.getItem(keyFor(what)) === '1' } catch { return false }
}
function writeFlag(what) {
  try { localStorage.setItem(keyFor(what), '1') } catch { /* storage blocked, fine */ }
}

const dismissed = ref(readFlag('dismissed'))
const guideRead = ref(readFlag('guide'))
/** @type {import('vue').Ref<import('@/types').ClubSetup|null>} */
const setup = ref(null)

const steps = computed(() => {
  const s = setup.value
  if (!s) return []
  const others = s.member_count - (s.you_are_member ? 1 : 0)
  const list = [
    { id: 'meet',   to: '/manager', done: s.meet_count > 0 },
    { id: 'invite', to: '/club',    done: others > 0 },
  ]
  if (s.can_edit_code || s.short_code) list.push({ id: 'code', to: '/club', done: !!s.short_code })
  list.push({ id: 'guide', to: '/guide#club-admin', done: guideRead.value })
  return list
})
const STEP_KEYS = {
  meet:   { title: 'dashboard.getting_started.step_meet',   desc: 'dashboard.getting_started.step_meet_desc' },
  invite: { title: 'dashboard.getting_started.step_invite', desc: 'dashboard.getting_started.step_invite_desc' },
  code:   { title: 'dashboard.getting_started.step_code',   desc: 'dashboard.getting_started.step_code_desc' },
  guide:  { title: 'dashboard.getting_started.step_guide',  desc: 'dashboard.getting_started.step_guide_desc' },
}
const doneCount = computed(() => steps.value.filter(s => s.done).length)
const allDone = computed(() => steps.value.length > 0 && doneCount.value === steps.value.length)

function onStepClick(step) {
  if (step.id === 'guide' && !guideRead.value) {
    guideRead.value = true
    writeFlag('guide')
  }
}

function dismiss() {
  dismissed.value = true
  writeFlag('dismissed')
}

onMounted(async () => {
  if (dismissed.value || !club.value) return
  try {
    setup.value = await auth.apiFetch(`/api/clubs/${club.value.id}/setup`)
  } catch {
    // No panel beats a broken one; the dashboard is fine without it.
  }
})
</script>

<template>
  <section v-if="!dismissed && setup" class="panel" data-testid="club-getting-started">
    <div class="gs-card">
      <div class="gs-head">
        <div>
          <h2 class="gs-title">{{ $t('dashboard.getting_started.title', { club: setup.name }) }}</h2>
          <p class="gs-intro">
            {{ allDone ? $t('dashboard.getting_started.all_done') : $t('dashboard.getting_started.intro') }}
          </p>
        </div>
        <div class="gs-head-right">
          <span class="gs-progress">
            {{ $t('dashboard.getting_started.progress', { done: doneCount, total: steps.length }) }}
          </span>
          <button type="button" class="btn btn-ghost btn-sm gs-dismiss" data-testid="club-getting-started-dismiss"
                  v-tip="$t('dashboard.getting_started.dismiss_tip')" @click="dismiss">
            <X class="gs-x" aria-hidden="true" />
            {{ $t('dashboard.getting_started.dismiss') }}
          </button>
        </div>
      </div>
      <ol class="gs-steps">
        <li v-for="step in steps" :key="step.id">
          <RouterLink :to="step.to" :class="['gs-step', step.done ? 'gs-step-done' : '']"
                      :data-testid="`gs-step-${step.id}`" :data-done="step.done ? 'true' : 'false'"
                      @click="onStepClick(step)">
            <span v-if="step.done" class="gs-tick" role="img" :aria-label="$t('dashboard.getting_started.done')">
              <Check class="gs-check" aria-hidden="true" />
            </span>
            <span v-else class="gs-tick" aria-hidden="true"></span>
            <span class="gs-text">
              <span class="gs-step-title">{{ $t(STEP_KEYS[step.id].title) }}</span>
              <span class="gs-step-desc">{{ $t(STEP_KEYS[step.id].desc) }}</span>
            </span>
          </RouterLink>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.gs-card {
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface); padding: var(--space-5);
  display: flex; flex-direction: column; gap: var(--space-4);
}
.gs-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
.gs-title { margin: 0; font-size: var(--text-h3); font-weight: 600; font-style: normal; color: var(--fg); }
.gs-intro { margin: var(--space-1) 0 0; font-size: var(--text-sm); color: var(--fg-3); max-width: 60ch; }
.gs-head-right { display: flex; align-items: center; gap: var(--space-3); }
.gs-progress { font-size: var(--text-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
.gs-dismiss { display: inline-flex; align-items: center; gap: var(--space-1); }
.gs-x { width: 14px; height: 14px; }
.gs-steps {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3);
}
.gs-step {
  display: flex; gap: var(--space-3); align-items: flex-start; height: 100%;
  padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius);
  text-decoration: none; color: inherit; background: var(--surface);
  transition: border-color 0.15s ease;
}
.gs-step:hover, .gs-step:focus-visible { border-color: var(--accent); }
.gs-tick {
  flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px;
  border: 1.5px solid var(--border); border-radius: var(--radius-pill);
  display: inline-flex; align-items: center; justify-content: center;
}
.gs-step-done .gs-tick { background: var(--ok-solid); border-color: var(--ok-solid); color: var(--fg-on-accent); }
.gs-check { width: 13px; height: 13px; }
.gs-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gs-step-title { font-size: var(--text-sm); font-weight: 600; color: var(--fg); }
.gs-step-done .gs-step-title { color: var(--fg-3); text-decoration: line-through; }
.gs-step-desc { font-size: var(--text-xs); color: var(--fg-3); line-height: 1.45; }
@media (prefers-reduced-motion: reduce) {
  .gs-step { transition: none; }
}
</style>
