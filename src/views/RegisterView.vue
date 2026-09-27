<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useCountryOptions } from '@/composables/useCountryOptions'
import CheckInboxPanel from '@/components/CheckInboxPanel.vue'
// Same file the server validates against (lib/countries.js). The picker
// comes from useCountryOptions; this is for the locale guess and the
// invite links below.
import COUNTRIES from '../../lib/countries.json'

const { t } = useI18n()
const route = useRoute()
const { countryOptions, countryName: nameOfCountry } = useCountryOptions()

// Invite links from a club admin's My club page look like
// /register?country=AUS&club=<club id>. Only a real country code is taken,
// and the club only once it turns up in that country's club list, so a
// mangled or doctored link just leaves the form as it would be anyway.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invite = (() => {
  const q = route.query
  const country = typeof q.country === 'string' ? q.country.trim().toUpperCase() : ''
  const club = typeof q.club === 'string' ? q.club.trim().toLowerCase() : ''
  const known = COUNTRIES.some(c => c.a3 === country)
  return {
    country: known ? country : '',
    club: known && UUID_RE.test(club) ? club : '',
    regionId: null,
  }
})()

const fullName = ref('')
const username = ref('')
const email = ref('')
const password = ref('')
// Default to "diver", the most common public-registration use case.
// Spectator-only sign-ups will pick "Spectator" explicitly.
const requestedRole = ref('diver')
const note = ref('')

// Club-first signup: country first, then whichever org runs that
// country on DivingHQ. Zero orgs means this registrant starts the
// country's account; one is the usual case; several only happens where
// federations already share a country code, and then they pick.
const countryCode = ref('')
const countryOrgs = ref([])
const countryLoaded = ref(false)
const orgId = ref('')

const countryName = computed(() => nameOfCountry(countryCode.value))

const selectedOrg = computed(() => countryOrgs.value.find(o => o.id === orgId.value) || null)

// Regions (states, provinces, home nations; migration 088). From the org
// when it has them, otherwise the built-in list for the country, which
// is what the server fills an unclaimed account in with when the first
// club lands. A new club has to pick one; for joining, it just narrows
// the club list.
const regionList = ref({ label: null, regions: [] })
const regionCode = ref('')
const regionLabel = computed(() => regionList.value.label ? t(`regions.label.${regionList.value.label}`) : '')
const selectedRegionId = computed(() =>
  regionList.value.regions.find(r => r.short_code === regionCode.value)?.id || null)
// A new club picking a region its state body has claimed (with someone
// still running it) asks to join rather than joining, same as on My club.
// Only the org's own list carries claim_state; the built-in catalogue is
// only used before anyone's there to claim anything.

const regionAsks = computed(() => {
  if (clubChoice.value !== 'new' || !noFederation.value) return null
  const r = regionList.value.regions.find(x => x.short_code === regionCode.value)
  return r?.claim_state === 'claimed' && r.has_live_admin !== false ? (r.claimed_name || r.name) : null
})

// Founding a club where there's no federation makes you its only admin, and
// a coach or judge request can't be self-approved, so it isn't "your club's
// admin" who reviews it.
const founderAsksUp = computed(() =>
  noFederation.value && clubChoice.value === 'new' && ['coach', 'judge'].includes(requestedRole.value))

// Bumped on every loadRegions call. A slow answer for a country or org
// the registrant has since moved off must not land on top of the current
// one (Australian states under Canada, then a 400 on submit), so each
// await checks it's still the latest request before touching state.
let regionsReq = 0

async function loadRegions() {
  const req = ++regionsReq
  regionList.value = { label: null, regions: [] }
  regionCode.value = ''
  if (!countryLoaded.value) return
  const code = countryCode.value
  const id = orgId.value
  try {
    let list = null
    if (id) list = await (await fetch(`/api/orgs/${id}/regions`)).json()
    if (req !== regionsReq) return
    const useCatalog = !id
      ? !countryOrgs.value.length
      : !list?.regions?.length && selectedOrg.value?.claim_state === 'unclaimed'
    if (useCatalog) list = await (await fetch(`/api/countries/${code}/regions`)).json()
    if (req !== regionsReq) return
    if (list?.regions) regionList.value = list
  } catch { /* no regions */ }
}
// No org yet (they'd create it) or an unclaimed one: no federation above
// the clubs, so club admins run things and meet_manager isn't on offer.
const noFederation = computed(() =>
  countryLoaded.value && (!countryOrgs.value.length || selectedOrg.value?.claim_state === 'unclaimed'))

// Club state, populated whenever an org is picked. The club
// dropdown has three modes: pick an existing one, "I want to create
// a new club", or leave it empty (independent diver).
const clubs = ref([])
const clubChoice = ref('')           // '' | 'new' | <club_id>
const newClubName = ref('')
const newClubCode = ref('')
// The server's reason a code was refused, in the reader's language.
const codeError = ref('')

const msg = ref('')
const msgType = ref('')
const loading = ref(false)
// Set once the account exists: the form gives way to the check-your-inbox
// panel, which stays until they leave (no timed bounce to /login).
// clubPending is { club, org } when the club they started waits for the
// federation to approve it (migration 096).
const registered = ref(null)   // { email, username, clubPending }

// Public signups are gated off by default (coming-soon launch). null means
// still checking, true is open (show the form), false is closed (show the notice).
const signupsEnabled = ref(null)

// Best guess at the registrant's country from the browser locale
// ("en-AU" -> AUS). Only a starting value, the select is theirs.
function guessCountry() {
  const region = (navigator.language || '').split('-')[1]?.toUpperCase()
  return COUNTRIES.find(c => c.a2 === region)?.a3 || ''
}

onMounted(async () => {
  try {
    const res = await fetch('/api/auth/signups-status')
    signupsEnabled.value = !!(await res.json()).enabled
  } catch {
    signupsEnabled.value = false
  }
  if (!signupsEnabled.value) return
  countryCode.value = invite.country || guessCountry()
})

watch(countryCode, async (code) => {
  countryOrgs.value = []
  countryLoaded.value = false
  orgId.value = ''
  if (!code) return
  try {
    const r = await fetch(`/api/orgs/by-country/${code}`)
    const body = await r.json()
    if (code !== countryCode.value) return   // they changed it again mid-fetch
    countryOrgs.value = Array.isArray(body) ? body : []
  } catch {
    countryOrgs.value = []
  }
  if (countryOrgs.value.length === 1) orgId.value = countryOrgs.value[0].id
  countryLoaded.value = true
})

watch(noFederation, (none) => {
  if (none && requestedRole.value === 'meet_manager') requestedRole.value = 'diver'
})

// Whoever brings a new club in is usually its coach, not a diver, so
// founding one flips the untouched default. Anything they picked
// themselves is left alone.
const roleTouched = ref(false)
watch(() => clubChoice.value, (choice, prev) => {
  if (roleTouched.value) return
  if (choice === 'new' && requestedRole.value === 'diver') requestedRole.value = 'coach'
  else if (prev === 'new' && requestedRole.value === 'coach') requestedRole.value = 'diver'
})
// Same staleness guard as loadRegions, for the club list.
let clubsReq = 0

watch(orgId, async (id) => {
  const req = ++clubsReq
  // Reset club state whenever the user changes org
  clubs.value = []
  clubChoice.value = ''
  newClubName.value = ''
  newClubCode.value = ''
  if (!id) return
  try {
    const r = await fetch(`/api/orgs/${id}/clubs`)
    const body = await r.json()
    if (req !== clubsReq) return
    clubs.value = Array.isArray(body) ? body : []
  } catch {
    if (req === clubsReq) clubs.value = []
  }
})

// A brand-new country has no clubs to load but still offers "create".
const showClubPicker = computed(() =>
  countryLoaded.value && (orgId.value || !countryOrgs.value.length))

// With a region picked, its clubs plus any not yet placed in one (clubs
// that signed up before their country had regions).
const visibleClubs = computed(() => {
  if (!selectedRegionId.value) return clubs.value
  return clubs.value.filter(c => !c.region_id || c.region_id === selectedRegionId.value)
})

watch([countryLoaded, orgId], () => { loadRegions() })

// Narrowing to another region can hide the club already picked. The
// select then shows blank but clubChoice still holds it, and it went off
// with the form: someone who picked NSW, then Sydney DC, then switched to
// VIC was signed up to Sydney DC. Drop a choice the list no longer shows.
watch(regionCode, () => {
  const c = clubChoice.value
  if (c && c !== 'new' && !visibleClubs.value.some(v => v.id === c)) clubChoice.value = ''
})
// Pick the invited club as soon as it's in the list, once; after that the
// picker is theirs. Its region too, where the country has them, so the
// region filter above agrees with the club. Clubs and regions load in
// either order, hence the two triggers.
watch(clubs, (list) => {
  const c = invite.club && list.find(x => x.id === invite.club)
  if (!c) return
  invite.club = ''
  clubChoice.value = c.id
  invite.regionId = c.region_id || null
  applyInviteRegion()
})
watch(() => regionList.value.regions, applyInviteRegion)
function applyInviteRegion() {
  const r = invite.regionId && regionList.value.regions.find(x => x.id === invite.regionId)
  if (!r) return
  invite.regionId = null
  regionCode.value = r.short_code
}

async function handleSubmit() {
  msg.value = ''
  msgType.value = ''
  loading.value = true
  try {
    const body = {
      full_name: fullName.value,
      username: username.value,
      email:    email.value || undefined,
      password: password.value,
    }
    if (orgId.value) body.org_id = orgId.value
    else body.country_code = countryCode.value
    if (requestedRole.value) body.requested_role = requestedRole.value
    if (note.value) body.note = note.value
    if (clubChoice.value === 'new' && regionList.value.regions.length && !regionCode.value) {
      throw new Error(t('regions.required', { label: regionLabel.value }))
    }
    if (clubChoice.value === 'new' && newClubName.value.trim()) {
      body.new_club_name = newClubName.value.trim()
      if (regionCode.value) body.region_code = regionCode.value
      if (newClubCode.value.trim()) body.new_club_short_code = newClubCode.value.trim()
    } else if (clubChoice.value && clubChoice.value !== 'new') {
      body.club_id = clubChoice.value
    }

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      const codeMsg = { bad_short_code: 'my_club.setup.code_bad', short_code_taken: 'my_club.setup.code_taken' }[data.code]
      if (codeMsg) {
        codeError.value = t(codeMsg)
        throw new Error(codeError.value)
      }
      throw new Error(data.error || t('auth.register.failed'))
    }
    registered.value = {
      email: email.value.trim(),
      username: username.value.trim(),
      clubPending: data.club_status === 'pending'
        ? { club: newClubName.value.trim(), org: data.org_name || selectedOrg.value?.name || '' }
        : null,
    }
  } catch (err) {
    msg.value = err.message
    msgType.value = 'error'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <div class="login-mark brand-wordmark">DIVING<span>HQ</span></div>

    <template v-if="signupsEnabled === false">
      <h1>{{ $t('auth.register.title') }}</h1>
      <p class="subtitle">{{ $t('auth.register.coming_soon') }}</p>
      <p class="note">{{ $t('auth.register.coming_soon_note') }}</p>
      <p class="footer-link">{{ $t('auth.register.already_have_account') }} <RouterLink to="/login">{{ $t('auth.register.sign_in_link') }}</RouterLink></p>
    </template>

    <template v-else-if="signupsEnabled === true">
    <h1>{{ $t('auth.register.title') }}</h1>
    <p class="subtitle">{{ $t('auth.register.subtitle') }}</p>

    <template v-if="registered">
      <CheckInboxPanel :email="registered.email" :username="registered.username" />
      <p v-if="registered.clubPending" class="note club-pending-note" data-testid="club-pending-note">
        {{ $t('auth.register.success_club_pending', registered.clubPending) }}
      </p>
    </template>
    <form v-else @submit.prevent="handleSubmit" class="form-stack">
      <div class="field">
        <label class="label">{{ $t('auth.register.full_name') }}</label>
        <!-- autocomplete="name" lets iOS surface the contact-card
             AutoFill chip for the user's own name. -->
        <input class="input" type="text" v-model="fullName"
               autocomplete="name" required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.username') }}</label>
        <!-- See LoginView: usernames are not sentences, suppress
             iOS keyboard auto-capitalize + autocorrect + spellcheck. -->
        <input class="input" type="text" v-model="username"
               autocomplete="username"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.email') }}</label>
        <input
          class="input"
          type="email"
          v-model="email"
          autocomplete="email"
          :placeholder="$t('auth.register.email_placeholder')"
          required
        >
        <span class="hint-line">{{ $t('auth.register.email_hint') }}</span>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.password') }}</label>
        <input class="input" type="password" v-model="password" autocomplete="new-password" required>
      </div>
      <div class="field">
        <label class="label">{{ $t('auth.register.country') }}</label>
        <select class="select" v-model="countryCode" required>
          <option value="">{{ $t('auth.register.country_placeholder') }}</option>
          <option v-for="c in countryOptions" :key="c.code" :value="c.code">{{ c.name }}</option>
        </select>
        <p v-if="countryLoaded && !countryOrgs.length" class="hint-line">
          {{ $t('auth.register.country_first', { country: countryName }) }}
        </p>
        <p v-else-if="selectedOrg && selectedOrg.claim_state === 'unclaimed'" class="hint-line">
          {{ $t('auth.register.country_unclaimed', { country: countryName }) }}
        </p>
        <p v-else-if="selectedOrg && countryOrgs.length === 1" class="hint-line">
          {{ $t('auth.register.country_joins', { org: selectedOrg.name }) }}
        </p>
        <p class="hint-line">
          {{ $t('auth.login.register_federation') }}
          <RouterLink to="/register-org">{{ $t('auth.login.register_federation_action') }}</RouterLink>
        </p>
      </div>

      <!-- Only where several federations share the country. -->
      <div class="field" v-if="countryOrgs.length > 1">
        <label class="label">{{ $t('auth.register.organisation') }}</label>
        <select class="select" v-model="orgId" required>
          <option value="">{{ $t('auth.register.org_placeholder') }}</option>
          <option v-for="org in countryOrgs" :key="org.id" :value="org.id">{{ org.name }}</option>
        </select>
      </div>

      <!-- Region, where the country has them. -->
      <div class="field" v-if="showClubPicker && regionList.regions.length">
        <label class="label" for="reg-region">{{ regionLabel }}</label>
        <select id="reg-region" class="select" v-model="regionCode" :required="clubChoice === 'new'">
          <option value="">{{ $t('regions.pick') }}</option>
          <option v-for="r in regionList.regions" :key="r.short_code" :value="r.short_code">{{ r.name }}</option>
        </select>
        <p v-if="regionAsks" class="hint-line" data-testid="region-will-ask">
          {{ $t('auth.register.region_will_ask', { region: regionAsks }) }}
        </p>
      </div>

      <!-- Club: pick an existing one, create a new one inline, or skip. -->
      <div class="field" v-if="showClubPicker">
        <label class="label">{{ $t('auth.register.club') }}</label>
        <select class="select" v-model="clubChoice">
          <option value="">{{ $t('auth.register.club_independent') }}</option>
          <option v-for="c in visibleClubs" :key="c.id" :value="c.id">
            {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
          </option>
          <option value="new">{{ $t('auth.register.club_new') }}</option>
        </select>
        <p v-if="!visibleClubs.length && clubChoice !== 'new'" class="hint-line">
          {{ $t('auth.register.club_no_clubs') }}
        </p>
      </div>

      <!-- Inline new-club form, only shows when "Create a new club" is picked -->
      <div v-if="showClubPicker && clubChoice === 'new'" class="field new-club-block">
        <div class="field">
          <label class="label">{{ $t('auth.register.new_club_name') }}</label>
          <input class="input" type="text" v-model="newClubName" :placeholder="$t('auth.register.new_club_placeholder')" required>
        </div>
        <div class="field">
          <label class="label">{{ $t('auth.register.short_code_optional') }}</label>
          <!-- Same rule the server applies (lib/club-approvals.js): up to 8,
               upper case. It used to take 20 and quietly keep the first 8. -->
          <input class="input code-input" type="text" v-model="newClubCode" :placeholder="$t('auth.register.short_code_placeholder')"
                 maxlength="8" autocapitalize="characters" autocomplete="off" data-testid="new-club-code"
                 :aria-invalid="codeError ? 'true' : undefined" @input="codeError = ''">
          <p v-if="codeError" class="hint-line code-error" data-testid="new-club-code-error">{{ codeError }}</p>
          <p v-else class="hint-line">{{ $t('my_club.setup.code_hint') }}</p>
        </div>
        <p v-if="noFederation" class="hint-line founder-note">{{ $t('auth.register.founder_note') }}</p>
        <!-- Under a federation a new club either waits for it or, where it
             lets clubs straight in, joins without an admin (migration 096). -->
        <p v-else-if="selectedOrg?.auto_approve_clubs" class="hint-line founder-note" data-testid="club-joins-now">
          {{ $t('auth.register.club_joins_now', { org: selectedOrg.name }) }}
        </p>
        <p v-else-if="selectedOrg" class="hint-line founder-note" data-testid="club-needs-approval">
          {{ $t('auth.register.club_needs_approval', { org: selectedOrg.name }) }}
        </p>
      </div>

      <div class="field">
        <label class="label">{{ $t('auth.register.requested_role') }}</label>
        <select class="select" v-model="requestedRole" @change="roleTouched = true">
          <option value="diver">{{ $t('auth.register.role_default') }}</option>
          <option value="coach">{{ $t('user_manager.role_coach') }}</option>
          <option value="judge">{{ $t('role.judge') }}</option>
          <option value="referee">{{ $t('role.referee') }}</option>
          <option v-if="!noFederation" value="meet_manager">{{ $t('role.manager') }}</option>
          <option value="">{{ $t('auth.register.role_spectator') }}</option>
        </select>
        <!-- A club can't hand out referee where there's no federation
             (lib/role-requests.js), so say who will look at it. -->
        <p v-if="noFederation && requestedRole === 'referee'" class="hint-line" data-test-id="referee-note">
          {{ $t('auth.register.referee_note_unclaimed') }}
        </p>
        <!-- A founder is their club's only admin, and nobody approves their
             own request for anything but diver (lib/role-requests.js), so
             the default coach request goes up a level. -->
        <p v-else-if="founderAsksUp" class="hint-line" data-testid="founder-role-note">
          {{ $t('auth.register.founder_role_note') }}
        </p>
      </div>
      <div class="field" v-if="requestedRole">
        <label class="label">{{ $t('auth.register.note_label') }}</label>
        <input class="input" type="text" v-model="note" :placeholder="$t('auth.register.note_placeholder')">
      </div>
      <!-- Where a note under the role already says who reviews it (referee,
           a founder's own coach or judge request), don't contradict it. -->
      <p class="note" data-testid="spectator-note">{{
        !noFederation ? $t('auth.register.spectator_note')
          : founderAsksUp || requestedRole === 'referee' ? $t('auth.register.spectator_note_see_above')
            : $t('auth.register.spectator_note_club') }}</p>
      <div v-if="msg" :class="['msg', msgType === 'success' ? 'msg-success' : 'msg-error']">{{ msg }}</div>
      <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem" :disabled="loading">
        {{ loading ? $t('auth.register.submit_loading') : $t('auth.register.submit_idle') }}
      </button>
      <LegalConsent />
    </form>
    <p v-if="!registered" class="footer-link">{{ $t('auth.register.already_have_account') }} <RouterLink to="/login">{{ $t('auth.register.sign_in_link') }}</RouterLink></p>
    </template>
  </div>
</template>

<style scoped>
/* dvh, not vh: iOS Safari's collapsing URL bar makes 100vh equal
   the *large* viewport (bar collapsed). With the bar expanded, the
   Submit button on iPhone SE-class screens ends up below the visible
   area. dvh tracks the live viewport instead. vh fallback goes first
   so browsers older than ~Q4-2022 still get a sane min-height; modern
   browsers just ignore it and use dvh. */
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.wrap { width: 100%; max-width: 460px; animation: fadeUp 0.4s ease; }
.login-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
  /* No `gap` here, see LoginView for the rationale. */
}
.login-mark span { color: var(--cyan); }
.login-mark::before { content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan); }
h1 { font-size: 48px; font-style: italic; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-3); font-size: 12px; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 600; text-transform: uppercase; }
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.footer-link { margin-top: 1.5rem; text-align: center; font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
.footer-link a { color: var(--cyan); text-decoration: none; }
.note { font-size: 11px; color: var(--text-3); line-height: 1.6; padding: 0.75rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.hint-line { margin-top: 0.4rem; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.code-input { text-transform: uppercase; font-family: var(--font-mono); }
.code-input::placeholder { text-transform: none; }
.code-error { color: var(--danger-fg); }
.founder-note { margin-top: 0; color: var(--text-2); }
.club-pending-note { margin-top: 1rem; color: var(--text-2); }
.new-club-block {
  display: flex; flex-direction: column; gap: 0.75rem;
  padding: 0.85rem;
  border: 1px dashed var(--cyan); border-radius: var(--radius-sm);
  background: var(--cyan-dim);
}
</style>
