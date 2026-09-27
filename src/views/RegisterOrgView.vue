<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useCountryOptions } from '@/composables/useCountryOptions'

const { t } = useI18n()
const { countryOptions, countryName: nameOfCountry } = useCountryOptions()

// Public signups are gated OFF by default (coming-soon launch). null = still
// checking, true = open (show the form), false = closed (show the notice).
const signupsEnabled = ref(null)
onMounted(async () => {
  try {
    const res = await fetch('/api/auth/signups-status')
    signupsEnabled.value = !!(await res.json()).enabled
  } catch {
    signupsEnabled.value = false
  }
})

const orgName = ref('')
const countryCode = ref('')
const fullName = ref('')
const email = ref('')
const username = ref('')
const password = ref('')
const msg = ref('')
const msgType = ref('')
const loading = ref(false)
const website = ref('')

// Every registration here is a claim (phase 3): on the account clubs
// already started for the country, on one of its regions, or on a
// country account the server starts for it when nobody from there is on
// DivingHQ yet. We look the country up as soon as it's picked so the form
// can say which of those is about to happen, before anyone submits.
const countryOrgs = ref([])
const countryLoaded = ref(false)
const regionList = ref({ label: null, regions: [] })
const regionCode = ref('')          // '' = the whole country

const countryName = computed(() => nameOfCountry(countryCode.value))
const unclaimedOrg = computed(() => countryOrgs.value.find(o => o.claim_state === 'unclaimed') || null)
const claimedOrgs = computed(() => countryOrgs.value.filter(o => o.claim_state === 'claimed'))
const regionName = computed(() => regionList.value.regions.find(r => r.short_code === regionCode.value)?.name || '')
const regionLabel = computed(() => regionList.value.label ? t(`regions.label.${regionList.value.label}`) : '')

// What submitting will do:
//   'claim_region_parent' / 'claim_region_vote'  a state body claiming its region
//   'claim_country'  claim the account the country's clubs started
//   'new_country'    nobody's here yet, the server starts the account to claim
//   'taken'          a federation already runs it, nothing to register
const claimKind = computed(() => {
  if (!countryCode.value || !countryLoaded.value) return null
  if (regionCode.value) {
    return claimedOrgs.value.length && !unclaimedOrg.value ? 'claim_region_parent' : 'claim_region_vote'
  }
  if (unclaimedOrg.value) return 'claim_country'
  return claimedOrgs.value.length ? 'taken' : 'new_country'
})

watch(countryCode, async (code) => {
  countryOrgs.value = []
  countryLoaded.value = false
  regionList.value = { label: null, regions: [] }
  regionCode.value = ''
  if (!code) return
  try {
    const orgs = await (await fetch(`/api/orgs/by-country/${code}`)).json()
    if (code !== countryCode.value) return
    countryOrgs.value = Array.isArray(orgs) ? orgs : []
    // Regions from the org when it has them, else the built-in list
    // (what the server fills a clubs' account in with).
    const org = countryOrgs.value.find(o => o.claim_state === 'unclaimed')
      || (countryOrgs.value.length === 1 ? countryOrgs.value[0] : null)
    let list = org ? await (await fetch(`/api/orgs/${org.id}/regions`)).json() : null
    if (!list?.regions?.length && (!org || org.claim_state === 'unclaimed')) {
      list = await (await fetch(`/api/countries/${code}/regions`)).json()
    }
    if (code !== countryCode.value) return
    if (list?.regions) regionList.value = list
  } catch {
    // Nothing more known about this country. Show what we have rather
    // than leave the form stuck; the server has the final say anyway.
    if (code !== countryCode.value) return
  }
  // Only now, so the notes don't flash "no regions" while they load.
  countryLoaded.value = true
})

// The website is optional and people type it the way they'd say it,
// "nswdiving.org.au", which a type="url" input refused (so the browser
// blocked the whole form over an optional field). The claim code adds the
// https:// itself (lib/claims.js domainMatches, ClaimsView's link), so
// all we check is that it's a plausible host.
const websiteTouched = ref(false)
function websiteLooksWrong(value) {
  const v = value.trim()
  if (!v) return false
  if (/\s/.test(v)) return true
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
    return !u.hostname.includes('.')
  } catch {
    return true
  }
}
const websiteInvalid = computed(() => websiteLooksWrong(website.value))

async function handleSubmit() {
  msg.value = ''
  msgType.value = ''
  if (websiteInvalid.value) {
    websiteTouched.value = true
    return
  }
  loading.value = true
  try {
    const body = {
      org_name: orgName.value,
      country_code: countryCode.value.toUpperCase(),
      full_name: fullName.value,
      email: email.value,
      username: username.value,
      password: password.value,
    }
    if (regionCode.value) body.region_code = regionCode.value
    if (website.value.trim()) body.website = website.value.trim()

    const res = await fetch('/api/auth/register-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || t('auth.register.failed'))
    msg.value = data.message
    msgType.value = 'success'
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
      <h1>{{ $t('auth.register_org.title') }}</h1>
      <p class="subtitle">{{ $t('auth.register.coming_soon') }}</p>
      <p class="note">{{ $t('auth.register_org.coming_soon_note') }}</p>
      <p class="footer-link">{{ $t('auth.register_org.already_registered') }} <RouterLink to="/login">{{ $t('auth.register_org.sign_in_link') }}</RouterLink></p>
    </template>

    <template v-else-if="signupsEnabled === true">
    <h1>{{ $t('auth.register_org.title') }}</h1>
    <p class="subtitle">{{ $t('auth.register_org.subtitle') }}</p>

    <!-- Clubs kept landing here from "Register your org" and either claimed
         their whole country or registered a federation named after the club. -->
    <div class="club-callout" data-testid="club-callout">
      <strong>{{ $t('auth.register_org.club_callout') }}</strong>
      <RouterLink to="/register">{{ $t('auth.register_org.club_callout_action') }}</RouterLink>
    </div>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="section">
        <div class="section-label">{{ $t('auth.register_org.section_org') }}</div>
        <div class="field">
          <label class="label" for="org-name">{{ $t('auth.register_org.fed_name_label') }}</label>
          <input id="org-name" class="input" type="text" v-model="orgName" :placeholder="$t('auth.register_org.fed_name_placeholder')" required>
        </div>
        <div class="field">
          <label class="label" for="org-country">{{ $t('auth.register.country') }}</label>
          <select id="org-country" class="select" v-model="countryCode" required>
            <option value="">{{ $t('auth.register.country_placeholder') }}</option>
            <option v-for="c in countryOptions" :key="c.code" :value="c.code">{{ c.name }}</option>
          </select>
        </div>
        <!-- National body, or one of the country's states / provinces. -->
        <div v-if="regionList.regions.length" class="field">
          <label class="label" for="org-region">{{ $t('auth.register_org.represents') }}</label>
          <select id="org-region" class="select" v-model="regionCode">
            <option value="">{{ $t('auth.register_org.represents_national', { country: countryName }) }}</option>
            <option v-for="r in regionList.regions" :key="r.short_code" :value="r.short_code">{{ regionLabel }}: {{ r.name }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="org-website">{{ $t('auth.register_org.website') }}</label>
          <input id="org-website" class="input" type="text" inputmode="url" v-model="website"
                 placeholder="www.example.org" autocomplete="url"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 :aria-invalid="websiteTouched && websiteInvalid ? 'true' : 'false'"
                 @blur="websiteTouched = true">
          <span v-if="websiteTouched && websiteInvalid" class="hint-line hint-error" role="alert">{{ $t('auth.register_org.website_invalid') }}</span>
          <span class="hint-line">{{ $t('auth.register_org.website_hint') }}</span>
        </div>
        <p v-if="claimKind" :class="['claim-note', claimKind === 'taken' ? 'claim-note-warn' : '']" data-testid="claim-note">
          <template v-if="claimKind === 'claim_country'">{{ $t('auth.register_org.claim_note_country', { country: countryName }) }}</template>
          <template v-else-if="claimKind === 'new_country'">{{ $t('auth.register_org.claim_note_new_country', { country: countryName }) }}</template>
          <template v-else-if="claimKind === 'taken'">{{ $t(regionList.regions.length ? 'auth.register_org.country_taken_region' : 'auth.register_org.country_taken', { org: claimedOrgs[0]?.name, country: countryName }) }}</template>
          <template v-else-if="claimKind === 'claim_region_parent'">{{ $t('auth.register_org.claim_note_region_parent', { org: claimedOrgs[0]?.name, region: regionName }) }}</template>
          <template v-else>{{ $t('auth.register_org.claim_note_region', { region: regionName }) }}</template>
        </p>
        <!-- Without a regions list a state body has nothing to pick, and
             submitting would claim the whole country instead. -->
        <p v-if="countryLoaded && !regionList.regions.length && claimKind !== 'taken'" class="hint-line">
          {{ $t('auth.register_org.no_regions_hint', { country: countryName }) }}
        </p>
      </div>

      <div class="section">
        <div class="section-label">{{ $t('auth.register_org.section_admin') }}</div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.full_name') }}</label>
          <!-- autocomplete="name" lets iOS surface the contact-
               card AutoFill chip for the admin's own name. -->
          <input class="input" type="text" v-model="fullName"
                 autocomplete="name" required>
        </div>
        <div class="field">
          <!-- Reuses the auth.register.* email strings (present in every
               locale); the org founder's email is required by
               /api/auth/register-org for the verification mail. -->
          <label class="label">{{ $t('auth.register.email') }}</label>
          <input class="input" type="email" v-model="email"
                 autocomplete="email"
                 :placeholder="$t('auth.register.email_placeholder')"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 required>
        </div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.username') }}</label>
          <!-- See LoginView: usernames are not sentences, suppress
               iOS keyboard auto-capitalize + autocorrect + spellcheck. -->
          <input class="input" type="text" v-model="username"
                 autocomplete="username"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 required>
        </div>
        <div class="field">
          <label class="label">{{ $t('auth.register_org.password') }}</label>
          <input class="input" type="password" v-model="password" autocomplete="new-password" required>
        </div>
      </div>

      <div v-if="msg" :class="['msg', msgType === 'success' ? 'msg-success' : 'msg-error']">{{ msg }}</div>
      <button type="submit" class="btn btn-primary-lg" :disabled="loading || claimKind === 'taken'">
        {{ loading ? $t('auth.register_org.submit_loading') : $t('auth.register_org.submit_idle') }}
      </button>
      <LegalConsent />
    </form>
    <p class="footer-link">{{ $t('auth.register_org.already_registered') }} <RouterLink to="/login">{{ $t('auth.register_org.sign_in_link') }}</RouterLink></p>
    </template>
  </div>
</template>

<style scoped>
/* dvh: see RegisterView.vue for the iOS Safari rationale.
   vh fallback first for browsers older than ~Q4-2022. */
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh;
  min-height: 100dvh;
  padding: 1.5rem;
}
.wrap { width: 100%; max-width: 520px; animation: fadeUp 0.4s ease; }
.login-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center;
  /* No `gap`, see LoginView for the rationale. */
}
.login-mark span { color: var(--cyan); }
.login-mark::before { content: ''; display: block; width: 24px; height: 2px; margin-inline-end: 0.75rem; background: var(--cyan); }
h1 { font-size: 44px; font-style: italic; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-3); font-size: 12px; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 600; text-transform: uppercase; }
.section-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.section { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.footer-link { margin-top: 1.5rem; text-align: center; font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
.footer-link a { color: var(--cyan); text-decoration: none; }
.note { font-size: 11px; color: var(--text-3); line-height: 1.6; padding: 0.75rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.club-callout {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.6rem;
  margin: -1.25rem 0 2rem; padding: 0.85rem 1rem;
  font-size: 13px; line-height: 1.5; color: var(--text);
  background: var(--cyan-dim); border: 1px solid var(--cyan); border-radius: var(--radius-sm);
}
.club-callout a { color: var(--cyan); font-weight: 600; }
.hint-line { margin-top: 0.4rem; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.hint-error { color: var(--danger-fg); }
.claim-note {
  margin: 0; font-size: 12px; line-height: 1.55; color: var(--fg-2);
  padding: 0.75rem; border-radius: var(--radius-sm);
  background: var(--accent-soft); border: 1px solid var(--accent-soft-2);
}
.claim-note-warn { background: var(--warn-bg); border-color: var(--warn-solid); color: var(--warn-fg); }
.btn-primary-lg:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
