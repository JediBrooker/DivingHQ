<script setup>
// The "Marine CRM" redesign introduces a persistent sidebar +
// top-bar shell. It wraps only the authenticated routes that opt
// in via `meta.appShell` (migrated screen-by-screen); every other
// route still renders standalone with its own header.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import AppShell from '@/components/AppShell.vue'
// Global notification stack lives at the app root so it floats
// over every route. The component itself is auth-aware — anonymous
// tabs get nothing, signed-in tabs see banners as the push engine
// fires.
import NotificationCenter from '@/components/NotificationCenter.vue'
// Global notify snackbar — single instance for the whole SPA.
// Any view fires showSuccess / showError / showInfo / showUndo
// from the composable; this renders. Used for async-action
// feedback (roster imported, score saved, …) and destructive
// actions with Undo (withdraw diver, finalise event, …).
import UndoBar from '@/components/UndoBar.vue'
// Global confirm modal — single instance. Replaces native
// window.confirm() with a styled modal that can spell out
// consequences. Any view calls confirmAction() from
// @/composables/useConfirm; this renders the dialog.
import ConfirmModal from '@/components/ConfirmModal.vue'
// Cmd-K command palette. Single global instance; opens on
// ⌘K / Ctrl-K from anywhere, or via the useAppChannel
// openCommandPalette() helper for header buttons that want a
// click-to-open affordance.
import CommandPalette from '@/components/CommandPalette.vue'
// First-login per-role tour. The setup wizard onboards fresh
// org admins; this fills the gap for the more common arrival
// path — a coach/judge/diver handed an invite. Auto-starts on
// the first dashboard mount per role; replay via Cmd-K.
import RoleTour from '@/components/RoleTour.vue'

const route = useRoute()
const auth = useAuthStore()
// Shell shows for signed-in users on opted-in routes — but never
// in the Scoreboard's broadcast/kiosk or stream-overlay modes,
// which are deliberately chromeless.
const useShell = computed(() =>
  auth.isLoggedIn &&
  route.meta.appShell === true &&
  route.params.mode !== 'broadcast' &&
  route.query.overlay !== '1' && route.query.overlay !== 'true'
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
