// Socket.IO does not retry a middleware refusal. Native ticket requests can
// fail while venue wifi changes, so recover them without reviving old leases.
export function createNativeSocketRecovery({
  socket, isCurrent, isPaused, onSessionExpired,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  let delay = 1000;
  let disposed = false;
  const live = () => !disposed && isCurrent() && !isPaused();
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const retry = () => {
    if (!live() || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      if (live()) socket.connect();
    }, delay);
    delay = Math.min(delay * 2, 30000);
  };
  const connected = () => { cancel(); delay = 1000; };
  const disconnected = (reason) => {
    if (reason !== 'io server disconnect' || !live()) return;
    onSessionExpired();
    retry();
  };
  socket.on('connect', connected);
  socket.on('connect_error', retry);
  socket.on('disconnect', disconnected);
  return {
    cancel,
    dispose() {
      disposed = true;
      cancel();
      socket.off('connect', connected);
      socket.off('connect_error', retry);
      socket.off('disconnect', disconnected);
    },
  };
}

// Called for every handshake, including reconnects. A response arriving after
// an account switch must never authenticate the old account's socket as the new one.
export function createSocketTicketAuth({ userId, requestTicket, onSessionExpired }) {
  return async (done) => {
    try {
      const response = await requestTicket();
      if (response.status === 401 || response.status === 403) onSessionExpired();
      const body = await response.json();
      done(response.ok && body.user_id === userId && typeof body.ticket === 'string'
        ? { ticket: body.ticket } : { ticket: 'invalid' });
    } catch { done({ ticket: 'invalid' }); }
  };
}
