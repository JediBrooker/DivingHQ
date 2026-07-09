<script setup>
// Shared identity block: renders a diver, synchro pair, or team
// entrant the same way wherever it shows up in the SPA. Both
// the Control Room and the Scoreboard mount this on their
// history cards, Up Next tiles, standings rows, and active-
// diver hero blocks. Layout choices (typography size, padding,
// click affordances) come from the surrounding parent's CSS;
// this component is just the inner shape.
//
// Visual contract:
//   ┌────────────────────────────────────────────┐
//   │ {rank.}  Lead Diver Name              [TST] │
//   │          & Partner Name                    │   ← synchro
//   │             OR                             │
//   │          Team / Club secondary line         │   ← non-synchro
//   └────────────────────────────────────────────┘
//
// The affiliation chip pins to the top-right of the names
// column. The lead + partner stack equal-weight (synchro is
// two equal performers, not a hero with a sidekick), and the
// secondary line dims a level (club / team affiliation, not a
// co-performer).
//
// Slots:
//   trailing:  anything that should sit alongside the badge on
//              the right edge (a score total, a dive total
//              chip, etc.). Renders inside .di-trailing.
//
// Profile links: the SPA links lead and partner names through
// to /profile/<id> when their ids are passed in. Anonymous
// surfaces (e.g. score broadcast strip) just leave the props
// undefined and the names render as plain text.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { diverIdentity } from '@/composables/useDiverIdentity'

const props = defineProps({
  // Any "row" shape: roster row, history row, standings row,
  // active-diver socket payload. The composable handles the
  // field-name variance.
  row: { type: Object, default: () => ({}) },
  // Optional 1-based rank prefix shown in front of the lead
  // diver's name. null/undefined = no prefix.
  rank: { type: [Number, String], default: null },
  // Profile-link ids. When non-null and `linkProfiles` is true
  // the names render as RouterLinks to /profile/<id>.
  competitorId: { type: String, default: null },
  partnerId:    { type: String, default: null },
  linkProfiles: { type: Boolean, default: false },
  // Affiliation rendering style:
  //   "compact":  single muted secondary line (team_name OR
  //               club_name). Right for roster rows + Up Next
  //               tiles where there isn't room for two lines.
  //   "split":    team_name as a purple chip line AND
  //               club_name + club_code as a separate muted
  //               line. Used by history cards so the operator
  //               sees both the team identity (for team events)
  //               and the diver's home club at a glance.
  // FYI, synchro pairs ignore both, partner_name takes the second
  // line regardless of variant.
  variant: {
    type: String,
    default: 'compact',
    validator: (v) => ['compact', 'split'].includes(v),
  },
})

const id = computed(() => diverIdentity(props.row))
</script>

<template>
  <div class="di-row">
    <div class="di-names">
      <!-- Names render as inline-baseline flex items inside a
           wrapping row. When the lead + partner both fit on a
           single line they sit side-by-side ("Lead Name &
           Partner Name"); when they don't (long names, narrow
           column) flex-wrap drops the partner onto its own
           row. Each .di-name is white-space:nowrap so a name
           never breaks mid-word, only the partner-as-a-whole
           wraps. -->
      <div class="di-names-row">
        <span class="di-name di-name-lead">
          <span v-if="rank != null" class="di-rank">{{ rank }}.</span>
          <RouterLink
            v-if="linkProfiles && competitorId"
            :to="`/profile/${competitorId}`"
            class="di-link"
            @click.stop
          >{{ id.leadName }}</RouterLink>
          <template v-else>{{ id.leadName }}</template>
        </span>
        <span v-if="id.partnerName" class="di-name di-name-partner">
          <span class="di-amp">&amp;</span>
          <RouterLink
            v-if="linkProfiles && partnerId"
            :to="`/profile/${partnerId}`"
            class="di-link"
            @click.stop
          >{{ id.partnerName }}</RouterLink>
          <template v-else>{{ id.partnerName }}</template>
        </span>
      </div>
      <template v-if="variant === 'split'">
        <!-- "Split" variant: team chip on its own purple line
             (matches the active-team styling on the centre
             column) + club name & code on a separate muted
             line. Either side renders only when present, so an
             individual diver with no team shows just the club
             line; a team-event entrant shows both. Synchro
             pairs render the partner row first (above) and
             then drop into these lines too, since the audience
             and operator still need to see which club a pair
             represents. -->
        <div v-if="id.teamName" class="di-team">{{ id.teamName }}</div>
        <div v-if="id.clubName" class="di-club">
          {{ id.clubName }}<span v-if="id.clubCode" class="di-club-code">{{ id.clubCode }}</span>
        </div>
      </template>
      <!-- Compact secondary stays a partner-OR-affiliation slot:
           if a partner is shown, secondary is suppressed in the
           composable; otherwise it renders the team-or-club
           one-liner the small surfaces (Up Next, roster) want. -->
      <div v-else-if="id.secondary" class="di-secondary">
        {{ id.secondary }}
      </div>
    </div>
    <!-- Right-side grouping. The badge column stacks chips
         vertically so an international synchro pair (lead + a
         partner from a different country / club) shows BOTH
         flags top-right: the lead's chip lines up next to the
         lead name, the partner's chip drops to the partner's
         line. align-self: start anchors the column to the top
         of the names; per-row alignment via the inner stack
         keeps everything baseline-tidy.
         The "trailing" slot (e.g. dive total) sits beside the
         badges, not under them, so it doesn't shift when the
         partner chip is/isn't there. -->
    <div class="di-trailing">
      <div v-if="id.badge || id.partnerBadge" class="di-badges">
        <span v-if="id.badge" class="di-badge">{{ id.badge }}</span>
        <span v-if="id.partnerBadge" class="di-badge di-badge-partner">{{ id.partnerBadge }}</span>
      </div>
      <slot name="trailing"></slot>
    </div>
  </div>
</template>

<style scoped>
.di-row {
  display: flex; align-items: flex-start; gap: 0.5rem;
  min-width: 0;
}
.di-names {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 0.05rem;
  line-height: 1.25;
}
/* Names row: flex-wrap so the lead + partner sit on the same
   line when there's room, and drop the partner onto its own
   line only when the available width forces it. The row's
   horizontal gap doubles as the spacing between names; the
   ampersand inside the partner span carries its own margin so
   it stays attached to the partner name on wrap. */
.di-names-row {
  display: flex; flex-wrap: wrap;
  align-items: baseline;
  column-gap: 0.4em; row-gap: 0;
}
/* Lead + partner share the same colour, weight, size, since
   synchro pairs are two equal performers. The cyan ampersand
   still reads as a connector so the eye groups them as one
   entry. white-space:nowrap keeps a single name from breaking
   mid-word; only the partner-as-a-whole wraps when the row
   can't fit it. */
.di-name {
  font-family: var(--font-display); font-weight: 700;
  font-size: inherit; color: var(--text);
  white-space: nowrap;
}
.di-rank {
  display: inline-block;
  margin-inline-end: 0.25rem;
  color: var(--cyan);
  font-family: var(--font-mono); font-weight: 700;
}
.di-amp {
  color: var(--cyan); margin-inline-end: 0.25em;
  font-weight: 400;
}
/* Match the SPA-wide .diver-link treatment: default colour at
   rest, on hover the text turns cyan AND gets a cyan dashed
   underline. Uses text-decoration (rather than border-bottom)
   so the underline survives parent overflow:hidden. The
   border-bottom approach used to get clipped inside the Up
   Next list on the scoreboard. */
.di-link {
  color: inherit;
  text-decoration: underline dashed transparent;
  text-decoration-thickness: 1px;
  /* 1px offset keeps the underline inside the line-box even
     in tight clipping contexts (parent overflow:hidden +
     line-height:normal). A larger offset would land below
     the parent's content-box and get clipped, heads up: same
     root cause as the .diver-link version. */
  text-underline-offset: 1px;
  transition: color 0.12s, text-decoration-color 0.12s;
}
.di-link:hover {
  color: var(--cyan);
  text-decoration-color: var(--cyan);
}
/* Team / club secondary line, only shown for non-synchro rows
   (synchro uses partner-name for the second line instead). One
   step down in weight + colour because affiliation is metadata,
   not a co-performer. */
.di-secondary {
  font-family: var(--font-mono); font-size: 0.85em;
  color: var(--text-3); font-weight: 400;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* Split-variant team chip: same purple system the centre
   column's .active-team uses, scaled down to fit the smaller
   history-card surface. Caps + letter-spacing keep it
   feeling chip-like even when the team name is long. */
.di-team {
  display: inline-block; margin-top: 0.15rem;
  font-family: var(--font-display); font-size: 0.72em; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--role-admin-fg);
  background: rgba(139,92,246,0.10); border: 1px solid rgba(139,92,246,0.45);
  border-radius: 3px; padding: 0.1rem 0.45rem;
  align-self: flex-start;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 100%;
}
.di-club {
  font-family: var(--font-mono); font-size: 0.78em;
  color: var(--text-3); font-weight: 400;
  margin-top: 0.1rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.di-club-code {
  font-family: var(--font-mono); font-size: 0.85em; font-weight: 700;
  color: var(--cyan); margin-inline-start: 0.4rem;
}
.di-trailing {
  display: flex; align-items: flex-start; gap: 0.4rem;
  flex-shrink: 0; align-self: flex-start;
}
/* Vertical stack: lead's chip on top, partner's chip
   underneath. Gap matches the names column's row gap (0.05rem)
   plus the chip's vertical padding so the second chip lines up
   visually next to the partner's name. */
.di-badges {
  display: flex; flex-direction: column; gap: 0.15rem;
  align-items: flex-end;
}
.di-badge {
  font-family: var(--font-display); font-size: 0.75em; font-weight: 700;
  letter-spacing: 0.08em; color: var(--text-3);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.4rem;
  white-space: nowrap;
}
/* Partner chip: uses a slightly muted background so the leads
   chip stays the visual anchor, but the partner chip is still
   the same size + colour so the pair reads as two equal entries
   in keeping with the lead/partner-equal-weight name treatment. */
.di-badge-partner {
  background: var(--bg-3, var(--bg));
}
</style>
