<script setup>
// Global maintenance-mode bar. Shows for everyone the moment the
// 'maintenance' feature flag is on (lib/features), across every screen
// including the kiosk scoreboard, so it lives in App.vue above the shell.
//
// It's a notice, not a guard: the actual write-blocking happens server-side
// (maintenanceGate in server.js + the socket gate in lib/middleware). A
// non-admin whose token doesn't refresh still can't write, they just wouldn't
// see this until their next load, so apiFetch also flips the flag on the first
// 503 it gets back (src/stores/auth.js).
import { computed } from 'vue'
import { useFeaturesStore } from '@/stores/features'
import { useAuthStore } from '@/stores/auth'
import { Wrench } from '@lucide/vue'

const features = useFeaturesStore()
const auth = useAuthStore()

const show = computed(() => features.maintenance)
const isAdmin = computed(() => Boolean(auth.user?.is_system_admin))
</script>

<template>
  <div v-if="show" class="maint-bar" role="status" aria-live="polite">
    <Wrench class="maint-icon" :size="16" aria-hidden="true" />
    <span class="maint-text">
      <strong>Maintenance mode.</strong>
      <template v-if="isAdmin">
        Changes are paused for everyone else while this is on. You can still edit.
      </template>
      <template v-else>
        Changes are paused for a short while. You can still view everything; please try again soon.
      </template>
    </span>
  </div>
</template>

<style scoped>
.maint-bar {
  display: flex;
  align-items: center;
  gap: .5rem;
  padding: .5rem 1rem;
  background: var(--warn-bg);
  color: var(--warn-fg);
  font-size: .85rem;
  font-weight: 600;
  line-height: 1.35;
  border-bottom: 1px solid color-mix(in srgb, var(--warn-fg) 25%, transparent);
  /* Sit above app chrome so it's never scrolled out of reach. */
  position: sticky;
  top: 0;
  z-index: 60;
}
.maint-icon { flex: none; }
.maint-text { min-width: 0; }
.maint-text strong { font-weight: 700; }
</style>
