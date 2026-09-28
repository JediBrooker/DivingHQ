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

//   * The lease on the socket follows the identity. This used to call
//     useSocket() in the watcher, which took a pooled lease nobody ever
//     released, so after sign-out the previous user's socket stayed
//     connected and authenticated as them, still in their rooms, and any
//     Control Room lease they held (freed only on disconnect) kept the
//     next operator locked out until a full reload.

import { watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { acquireSocket } from './useSocket'
import { armOutboxDrain, disarmOutboxDrain } from './useHttpOutbox'

export function useOutboxSync() {
  const auth = useAuthStore()
  let lease = null

  watch(
    () => auth.user?.id,
    (id) => {
      if (lease) {
        lease.release()
        lease = null
      }
      if (!id) {
        disarmOutboxDrain()
        return
      }
      lease = acquireSocket({ userId: id })
      armOutboxDrain(auth, lease.socket)
    },
    { immediate: true },
  )
}
