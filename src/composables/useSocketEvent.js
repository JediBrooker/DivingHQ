// Auto-cleaned socket listener registration.
//
// The pooled socket from useSocket() outlives individual views, becuase
// NotificationCenter at the app root keeps the auth socket's refcount
// alive. So a bare `socket.on(...)` in a view's setup survives unmount
// and stacks a duplicate handler on every navigation back to that
// view. This helper pairs the `.on` with an automatic `.off` when the
// calling effect scope (normally the component) is disposed.
//
// Must be called synchronously during setup (or inside another
// active effect scope). For registration after an `await` or in a
// callback, use a named handler with an explicit `socket.off` in
// onUnmounted instead.

import { onScopeDispose } from 'vue'

export function useSocketEvent(socket, event, handler) {
  socket.on(event, handler)
  onScopeDispose(() => socket.off(event, handler))
}
