// App-level outbox keep-alive.
//
// The outbox promises (src/guide/content/offline-competitions.md) that a
// queued operation "survives page refreshes, navigation between views, and
// even closing and reopening the browser", and drains "automatically" when
// the connection comes back. It didn't. The connect -> drain hook lived
// inside useHttpOutbox(), which only the Control Room's own components
// call, so the machinery existed exactly as long as the Control Room was
// on screen. Refresh mid-meet on bad venue wifi and you landed elsewhere
// with unsent scores sitting in IndexedDB, reconnected, and nothing moved
// them.
//
// Mounting this once from App.vue arms the hook for the whole session,
// whatever route the operator ends up on.
//
// Two things to be careful about, both learned the hard way:
//
//   * Anonymous tabs must not touch the outbox. getOutbox() bakes
//     fingerprintFromUser(auth.user) into the instance, and for a signed
//     out visitor that's the literal string 'anon'. Create it then and the
//     singleton is pinned to a queue nobody owns. So we wait for an
//     identity, and re-arm if one arrives later (sign in without a reload).
//   * useSocket() keys its connection pool on the user id, so calling it
//     before there IS a user id would open an unauthenticated socket that
//     just fails and retries.

import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from './useSocket'
import { armOutboxDrain } from './useHttpOutbox'

export function useOutboxSync() {
  const auth = useAuthStore()

  watch(
    () => auth.user?.id,
    (id) => {
      if (!id) return
      // useSocket() outside a component setup: it checks getCurrentInstance()
      // before registering onUnmounted, so this just skips the auto-release.
      // Which is what we want, the socket should outlive every route.
      armOutboxDrain(auth, useSocket())
    },
    { immediate: true },
  )
}
