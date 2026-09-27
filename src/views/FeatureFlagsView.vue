<script setup>
// Platform kill switches (feature_flags, migration 085). System admin only,
// enforced for real by requireSystemAdmin on the API; the route meta just
// keeps the link out of everyone else's way.
//
// The kill-switch half is English-only, no i18n keys. Adding to en.json
// obliges a translation into every locale (test/i18n-parity.test.js) and
// that part is read by roughly one person. Same call the payments admin UI
// already made. The claim voting rules further down are translated: they
// came in with the club-first screens, which all are.
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { showSuccess, showError } from '@/composables/useNotify'
import LoadError from '@/components/LoadError.vue'

const { t, te } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()

const flags = ref([])
const loading = ref(true)

// Claim-vote rules (platform_settings, migration 089, lib/claims.js).
// Numbers, not switches, so they get their own little form below.
const settings = ref([])
const settingDraft = ref({})
const settingSaving = ref({})
const settingsFailed = ref(false)

async function loadSettings() {
  settingsFailed.value = false
  try {
    settings.value = await auth.apiFetch('/api/admin/settings')
    settingDraft.value = Object.fromEntries(settings.value.map(s => [s.key, s.value]))
  } catch {
    settingsFailed.value = true
  }
}

// Label and description in the reader's language. The server's English
// is the fallback for a knob added to lib/platform-settings.js before its
// strings were.
function settingText(s, field) {
  const key = `admin_settings.${s.key}.${field}`
  return te(key) ? t(key) : s[field]
}

// What's wrong with the draft, or '' if it's fine. An emptied type=number
// field reads back as '', and Number('') is 0, which the old check took
// for a new value and sent: clearing "Club age to vote" to retype it and
// hitting Save let brand-new clubs vote on claims.
function settingError(s) {
  const raw = String(settingDraft.value[s.key] ?? '').trim()
  if (raw === '') return t('admin_settings.required')
  const n = Number(raw)
  if (!Number.isFinite(n)) return t('admin_settings.not_number')
  if (s.integer && !Number.isInteger(n)) return t('admin_settings.whole')
  if (n < s.min || n > s.max) return t('admin_settings.range', { min: s.min, max: s.max })
  return ''
}

function settingUnchanged(s) {
  return Number(String(settingDraft.value[s.key] ?? '').trim()) === s.value
}

async function saveSetting(s) {
  // The button is disabled in both cases; this is the belt to its braces.
  if (settingError(s) || settingUnchanged(s)) return
  settingSaving.value = { ...settingSaving.value, [s.key]: true }
  try {
    const res = await auth.apiFetch(`/api/admin/settings/${s.key}`, {
      method: 'PUT',
      // The trimmed text as typed; the server parses it and refuses
      // anything that isn't a number in range.
      body: JSON.stringify({ value: String(settingDraft.value[s.key]).trim() }),
    })
    s.value = res.value
    settingDraft.value[s.key] = res.value
    showSuccess(t('admin_settings.saved', { label: settingText(s, 'label'), value: res.value }))
  } catch (err) {
    showError(err.message)
    settingDraft.value[s.key] = s.value
  } finally {
    settingSaving.value = { ...settingSaving.value, [s.key]: false }
  }
}
// Keyed by flag so one row's spinner doesn't freeze the others.
const saving = ref({})

async function load() {
  loading.value = true
  try {
    const { features: rows } = await auth.apiFetch('/api/features/admin')
    flags.value = rows
  } catch (err) {
    showError(err.message || 'Could not load the feature flags.')
  } finally {
    loading.value = false
  }
}

async function toggle(flag) {
  if (saving.value[flag.key]) return
  const next = !flag.enabled
  saving.value = { ...saving.value, [flag.key]: true }
  try {
    const res = await auth.apiFetch(`/api/features/${flag.key}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: next }),
    })
    flag.enabled = res.enabled
    // Write through to the store so the sidebar grows or loses its links
    // right now, rather than on the next full page load.
    features.apply(flag.key, res.enabled)
    showSuccess(`${flag.label} ${res.enabled ? 'enabled' : 'disabled'}.`)
    // Pick up updated_at / who, which only the server knows.
    load()
  } catch (err) {
    showError(err.message || `Could not update ${flag.label}.`)
  } finally {
    saving.value = { ...saving.value, [flag.key]: false }
  }
}

function whenLine(flag) {
  if (!flag.updated_at) return 'Never changed'
  const when = new Date(flag.updated_at).toLocaleString()
  return flag.updated_by_name ? `${when} by ${flag.updated_by_name}` : when
}

onMounted(() => { load(); loadSettings() })
</script>

<template>
  <div class="ff-page">
    <div class="ff-wrap">
      <div class="ff-head">
        <h1 class="ff-title">Feature Flags</h1>
        <p class="ff-sub">
          Switch whole product areas on or off for every user on this deployment.
          Changes take effect immediately, no restart. Each flip is written to the audit log.
        </p>
      </div>

      <p v-if="loading" class="ff-empty">Loading…</p>

      <template v-else>
        <div v-for="flag in flags" :key="flag.key" class="card ff-row">
          <div class="ff-info">
            <div class="ff-row-head">
              <span class="ff-name">{{ flag.label }}</span>
              <span class="ff-state" :class="flag.enabled ? 'is-on' : 'is-off'">
                {{ flag.enabled ? 'On' : 'Off' }}
              </span>
            </div>
            <p class="ff-desc">{{ flag.description }}</p>
            <p class="ff-meta">{{ whenLine(flag) }}</p>
          </div>

          <button
            type="button"
            class="btn btn-sm"
            :class="flag.enabled ? 'btn-danger' : 'btn-primary'"
            :disabled="saving[flag.key]"
            @click="toggle(flag)"
          >
            {{ saving[flag.key] ? 'Saving…' : (flag.enabled ? 'Turn off' : 'Turn on') }}
          </button>
        </div>

        <p class="ff-foot">
          Turning payments on also needs <code>STRIPE_SECRET_KEY</code> and
          <code>STRIPE_WEBHOOK_SECRET</code> in the environment. Without them the
          checkout routes stay dark whatever this switch says.
        </p>

        <div v-if="settings.length || settingsFailed" class="ff-head ff-section">
          <h2 class="ff-h2">{{ $t('admin_settings.title') }}</h2>
          <p class="ff-sub">{{ $t('admin_settings.intro') }}</p>
        </div>
        <LoadError v-if="settingsFailed" @retry="loadSettings" />
        <div v-for="s in settings" :key="s.key" class="card ff-row">
          <div class="ff-info">
            <label class="ff-name" :for="`set-${s.key}`">{{ settingText(s, 'label') }}</label>
            <p class="ff-desc">{{ settingText(s, 'description') }}</p>
            <p class="ff-meta">{{ $t('admin_settings.bounds', { default_value: s.default, min: s.min, max: s.max }) }}</p>
          </div>
          <div class="ff-setting-col">
            <div class="ff-setting">
              <input :id="`set-${s.key}`" class="input input-num" type="number"
                     :min="s.min" :max="s.max" :step="s.integer ? 1 : 0.05"
                     :aria-invalid="settingError(s) ? 'true' : 'false'"
                     :aria-describedby="settingError(s) ? `set-${s.key}-err` : undefined"
                     v-model="settingDraft[s.key]"
                     @keydown.enter.prevent="saveSetting(s)">
              <button type="button" class="btn btn-sm btn-primary"
                      :disabled="settingSaving[s.key] || !!settingError(s) || settingUnchanged(s)"
                      @click="saveSetting(s)">{{ $t('common.save') }}</button>
            </div>
            <p v-if="settingError(s)" :id="`set-${s.key}-err`" class="ff-err" role="alert">{{ settingError(s) }}</p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ff-page { min-height: 100%; background: var(--bg); }
.ff-wrap { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2.5rem; }

.ff-head { margin-bottom: 1.25rem; }
.ff-title {
  font-size: var(--text-h1); font-weight: 700; color: var(--text);
  letter-spacing: var(--ls-h1); line-height: var(--lh-h1);
}
.ff-sub { margin: .35rem 0 0; color: var(--text-2, #666); font-size: .9rem; line-height: 1.5; }
.ff-empty { color: var(--text-2, #666); }

.ff-row {
  display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between;
  margin-bottom: .85rem; padding: 1rem 1.1rem;
}
.ff-info { min-width: 0; }
.ff-row-head { display: flex; align-items: center; gap: .5rem; }
.ff-name { font-weight: 650; color: var(--text); }

.ff-state {
  font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
  padding: .1rem .4rem; border-radius: .3rem;
}
.ff-state.is-on { background: var(--ok-bg); color: var(--ok-fg); }
.ff-state.is-off { background: var(--surface-2); color: var(--text-2); }

.ff-desc { margin: .4rem 0 0; color: var(--text-2, #666); font-size: .85rem; line-height: 1.5; }
.ff-meta { margin: .45rem 0 0; color: var(--text-3, #999); font-size: .75rem; }

.ff-foot { margin-top: 1.25rem; color: var(--text-3, #999); font-size: .78rem; line-height: 1.6; }
.ff-foot code {
  background: var(--surface-2, #eee); padding: .05rem .3rem;
  border-radius: .25rem; font-size: .95em;
}

.ff-section { margin-top: 2rem; }
.ff-h2 { font-size: var(--text-h2); font-weight: 650; color: var(--text); margin: 0; }
.ff-setting-col { display: flex; flex-direction: column; align-items: flex-end; gap: .3rem; flex: none; max-width: 14rem; }
.ff-setting { display: flex; gap: .5rem; align-items: center; }
.ff-err { margin: 0; color: var(--danger-fg); font-size: .75rem; text-align: end; }
.input-num { width: 5.5rem; }

/* The button must not shrink under a long description. */
.ff-row > .btn { flex: none; }
</style>
