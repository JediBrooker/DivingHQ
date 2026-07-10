<script setup>
// The "Marine CRM" redesign added a persistent sidebar + top-bar
// shell. It only wraps the authenticated routes that opt in via
// `meta.appShell` (migrated screen-by-screen); every other route
// still renders standalone with its own header.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/AppShell.vue'
// Global notification stack lives at the app root so it floats
// over every route. The component itself is auth-aware: anonymous
// tabs get nothing, signed-in tabs see banners once the push engine
// fires.
import NotificationCenter from '@/components/NotificationCenter.vue'
// Global notify snackbar, one instance for the whole SPA.
// Any view fires showSuccess / showError / showInfo / showUndo
// from the composable and this renders it. Used for async-action
// feedback (roster imported, score saved, …) and for destructive
// actions that need an Undo (withdraw diver, finalise event, …).
import UndoBar from '@/components/UndoBar.vue'
// Global confirm modal, single instance. Replaces native
// window.confirm() with a styled modal that can actually spell
// out consequences. Any view calls confirmAction() from
// @/composables/useConfirm and this renders the dialog.
import ConfirmModal from '@/components/ConfirmModal.vue'
// Cmd-K command palette. Single global instance, opens on
// ⌘K / Ctrl-K from anywhere, or via the useAppChannel
// openCommandPalette() helper for header buttons that want a
// click-to-open affordance instead.
import CommandPalette from '@/components/CommandPalette.vue'
// First-login per-role tour. The setup wizard onboards fresh
// org admins, so this fills the gap for the more common arrival
// path: a coach/judge/diver who just got handed an invite. Auto-starts
// on the first dashboard mount per role, replay it via Cmd-K.
import RoleTour from '@/components/RoleTour.vue'
// Keeps the offline outbox draining for the whole session rather than only
// while the Control Room happens to be rendered. No template of its own.
import { useOutboxSync } from '@/composables/useOutboxSync'

const route = useRoute()
const auth = useAuthStore()

useOutboxSync()
// Shell shows for signed-in users on opted-in routes, but never
// in the Scoreboard's broadcast/kiosk or stream-overlay modes.
// Those are deliberately chromeless.
const useShell = computed(() =>
  auth.isLoggedIn &&
  route.meta.appShell === true &&
  route.params.mode !== 'broadcast' &&
  route.query.overlay !== '1' && route.query.overlay !== 'true' &&
  route.query.overlay !== 'minimal'
)
</script>

<template>
  <AppShell v-if="useShell">
    <RouterView />
  </AppShell>
  <RouterView v-else />
  <NotificationCenter />
  <UndoBar />
  <ConfirmModal />
  <CommandPalette />
  <RoleTour />
</template>
