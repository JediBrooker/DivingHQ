<script setup>
import { onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { User, ChevronRight, CircleHelp, LogOut } from '@lucide/vue'
import { useAuthStore } from '@/stores/auth'
import { signOut } from '@/composables/useSignOut'
import ThemeToggle from '@/components/ThemeToggle.vue'
import NotificationSettings from '@/components/NotificationSettings.vue'
import { setPageTitle } from '@/lib/pageTitle'

const auth = useAuthStore()
const router = useRouter()
onMounted(() => setPageTitle('Settings'))
</script>

<template>
  <div class="settings-page">
    <header><h1>Settings</h1><p>Your account, notifications and appearance.</p></header>
    <div class="settings-grid">
      <div class="settings-column">
        <section class="settings-section" aria-labelledby="settings-account">
          <h2 id="settings-account">Account</h2>
          <RouterLink to="/profile" class="settings-row">
            <User aria-hidden="true" />
            <span><strong>{{ auth.user?.full_name || auth.user?.username }}</strong><small>Profile, password and account details</small></span>
            <ChevronRight aria-hidden="true" />
          </RouterLink>
        </section>
        <div class="settings-section"><NotificationSettings /></div>
      </div>
      <div class="settings-column">
        <section class="settings-section" aria-labelledby="settings-appearance">
          <h2 id="settings-appearance">Appearance</h2>
          <p>Choose the theme for this device.</p>
          <ThemeToggle />
        </section>
        <section class="settings-section" aria-labelledby="settings-help">
          <h2 id="settings-help">Help & information</h2>
          <RouterLink to="/guide" class="settings-row"><CircleHelp aria-hidden="true" /><span>User guide</span><ChevronRight aria-hidden="true" /></RouterLink>
          <RouterLink to="/privacy" class="settings-row"><span>Privacy policy</span><ChevronRight aria-hidden="true" /></RouterLink>
          <RouterLink to="/terms" class="settings-row"><span>Terms of service</span><ChevronRight aria-hidden="true" /></RouterLink>
        </section>
        <button class="btn btn-ghost settings-signout" type="button" @click="signOut(auth, router)"><LogOut aria-hidden="true" />Sign out</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page { max-width: 1100px; margin: 0 auto; padding: 24px; padding-bottom: max(24px, env(safe-area-inset-bottom, 0px)); }
.settings-page h1 { margin: 0; font-size: 26px; color: var(--fg); }
.settings-page header p, .settings-section p { color: var(--fg-2); line-height: 1.5; }
.settings-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 24px; margin-top: 24px; align-items: start; }
.settings-column { display: grid; gap: 20px; min-width: 0; }
.settings-section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px; min-width: 0; }
.settings-section h2 { font-size: 16px; margin: 0 0 16px; color: var(--fg); }
.settings-row { display: flex; align-items: center; gap: 12px; min-height: 52px; color: var(--fg); text-decoration: none; border-radius: var(--radius); padding: 8px 0; }
.settings-row + .settings-row { border-top: 1px solid var(--border); }
.settings-row:hover { color: var(--accent); }
.settings-row span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.settings-row strong, .settings-row small { display: block; }
.settings-row small { color: var(--fg-2); margin-top: 4px; }
.settings-row svg, .settings-signout svg { width: 20px; height: 20px; flex-shrink: 0; }
.settings-signout { min-height: 48px; justify-self: start; }
.settings-section :deep(.theme-toggle button) { min-height: 44px; font-size: 14px; }
@media (max-width: 1050px) { .settings-grid { grid-template-columns: minmax(0, 1fr); gap: 20px; } }
@media (max-width: 600px) { .settings-page { padding: 20px 14px; } .settings-section { padding: 16px; } }
</style>
