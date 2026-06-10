<script setup>
/* SignoffModal — referee dive-order sign-off, extracted from
 * ControlView.vue (Cut 2 + Cut 3). Four paths: push to the
 * referee's device, 6-digit handoff code (+ QR), referee
 * credentials at this device, and the manager-attests fallback
 * (hidden + refused server-side when enforce_referee_signoff).
 *
 * Lifecycle contract: the parent mounts this with v-if, so a
 * fresh mount = a fresh modal session (mode reset to 'push',
 * no pending request). The referee_signoff_response socket
 * listener is registered synchronously here via useSocketEvent —
 * it only needs to live while a request can be pending, and a
 * pending request can only exist while this modal is mounted
 * (closing clears it), so scoping the listener to this component
 * preserves the pre-extraction behaviour.
 *
 * State boundary: everything about the in-flight sign-off is
 * OWNED here. A successful sign-off emits `signed-off` with the
 * event-row patch; the parent applies it via patchCurrentEvent.
 */
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { useSocketEvent } from '@/composables/useSocketEvent'
import { confirmAction } from '@/composables/useConfirm'

const props = defineProps({
  event: { type: Object, required: true },
})
const emit = defineEmits(['close', 'signed-off'])

const auth = useAuthStore()
const socket = useSocket()

const signoffMode        = ref('push')   // 'push' | 'code' | 'credential' | 'manager'
const signoffReferees    = ref([])
const signoffPickedRefId = ref('')
const signoffWaiting     = ref(null)     // push: { request_id, expires_at, referee_name }
const signoffCode        = ref(null)     // code: { request_id, code, expires_at, referee_name }
const signoffError       = ref('')
const credUsername       = ref('')
const credPassword       = ref('')
const credCode           = ref('')
const credNeedsTotp      = ref(false)
const busy               = ref(false)

// Whether the simple manager-attests path is allowed for the
// current event. Server enforces too; this just hides the tab
// when the event was created with enforce_referee_signoff = TRUE.
const enforceSignoff = computed(() =>
  !!props.event?.enforce_referee_signoff
)

function close() {
  signoffWaiting.value = null
  signoffCode.value = null
  signoffError.value = ''
  emit('close')
}

// Pull the referee list once when the modal opens (= mounts).
// Best-effort — if it fails the modal still works via the
// credential tab.
;(async () => {
  try {
    signoffReferees.value = await auth.apiFetch(
      `/api/events/${props.event.id}/referees`,
    )
  } catch {
    signoffReferees.value = []
  }
})()

async function sendSignoffPush() {
  if (!props.event || !signoffPickedRefId.value) return
  signoffError.value = ''
  busy.value = true
  try {
    const r = await auth.apiFetch(
      `/api/events/${props.event.id}/dive-order/sign-off/request`,
      {
        method: 'POST',
        body: JSON.stringify({ referee_id: signoffPickedRefId.value }),
      },
    )
    const refRow = signoffReferees.value.find(x => x.id === signoffPickedRefId.value)
    signoffWaiting.value = {
      request_id: r.request_id,
      expires_at: r.expires_at,
      referee_name: refRow?.full_name || 'the referee',
    }
  } catch (err) {
    signoffError.value = err.message
  } finally {
    busy.value = false
  }
}

async function submitCredentialSignoff() {
  if (!props.event) return
  signoffError.value = ''
  busy.value = true
  try {
    const body = {
      username: credUsername.value.trim(),
      password: credPassword.value,
    }
    if (credNeedsTotp.value && credCode.value) body.code = credCode.value.trim()
    await auth.apiFetch(
      `/api/events/${props.event.id}/dive-order/sign-off/credential`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    // Server stamped the sign-off in the same transaction. Mirror
    // locally so the workflow button flips green immediately.
    emit('signed-off', {
      dive_order_signed_off_at: new Date().toISOString(),
    })
    close()
  } catch (err) {
    // Server signals "TOTP required" by returning needs_totp:true.
    // Surface the second-factor field rather than a vague 401.
    const msg = err.message || ''
    if (/totp/i.test(msg) || /code/i.test(msg)) {
      credNeedsTotp.value = true
      signoffError.value = credCode.value
        ? 'Invalid TOTP code'
        : 'TOTP code required'
    } else {
      signoffError.value = msg || 'Sign-off failed'
    }
  } finally {
    busy.value = false
  }
}

// Server broadcast when the referee taps Approve/Deny on their
// device, AND when they type a Cut 3 handoff code on their own
// /sign-off-codes page (server fires the same broadcast).
function onRefereeSignoffResponse(data) {
  // Match against either the push-waiting request OR the code-
  // waiting request — both store request_id and only one is
  // active at a time per modal session.
  const waitingId = signoffWaiting.value?.request_id || signoffCode.value?.request_id
  if (!waitingId || data?.request_id !== waitingId) return
  if (data.decision === 'approved') {
    emit('signed-off', {
      dive_order_signed_off_at: new Date().toISOString(),
      dive_order_signed_off_by: data.by_user_id,
    })
    close()
  } else {
    const refereeName =
      signoffWaiting.value?.referee_name || signoffCode.value?.referee_name || 'The referee'
    signoffError.value = `${refereeName} declined the request.`
    signoffWaiting.value = null
    signoffCode.value = null
  }
}
useSocketEvent(socket, 'referee_signoff_response', onRefereeSignoffResponse)

// Cut 3: ask the server for a 6-digit handoff code for the
// chosen referee. Display it; the referee types it on their own
// /sign-off-codes page on their already-signed-in device.
async function generateSignoffCode() {
  if (!props.event || !signoffPickedRefId.value) return
  signoffError.value = ''
  busy.value = true
  try {
    const r = await auth.apiFetch(
      `/api/events/${props.event.id}/dive-order/sign-off/code`,
      {
        method: 'POST',
        body: JSON.stringify({ referee_id: signoffPickedRefId.value }),
      },
    )
    const refRow = signoffReferees.value.find(x => x.id === signoffPickedRefId.value)
    signoffCode.value = {
      request_id:  r.request_id,
      code:        r.code,
      expires_at:  r.expires_at,
      qr_data_url: r.qr_data_url || null,
      deep_link:   r.deep_link   || null,
      referee_name: refRow?.full_name || 'the referee',
    }
  } catch (err) {
    signoffError.value = err.message
  } finally {
    busy.value = false
  }
}

// Manager-attests path. Fires the simple endpoint (which the
// server refuses if the event has enforce_referee_signoff = TRUE).
// Hidden in the UI under the same condition; this is the
// belt-and-braces server-trip.
async function managerAttestSignoff() {
  if (!props.event) return
  if (!await confirmAction({
    title: 'Sign off as meet manager?',
    body:  `Use this fallback only when you've already confirmed the dive order with the referee verbally.`,
    consequences: [
      `Your name (${auth.user?.full_name || 'manager'}) is recorded against the event audit trail`,
      'The referee can countersign later if your federation requires it',
    ],
    confirmLabel: 'Attest sign-off',
    confirmKind:  'warn',
  })) return
  busy.value = true
  try {
    const r = await auth.apiFetch(
      `/api/events/${props.event.id}/dive-order/sign-off`,
      { method: 'POST' },
    )
    emit('signed-off', {
      dive_order_signed_off_at: r.dive_order_signed_off_at || new Date().toISOString(),
      dive_order_signed_off_by: r.dive_order_signed_off_by,
    })
    close()
  } catch (err) {
    signoffError.value = err.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="lb-backdrop" @click="close"></div>
  <div class="lb-modal signoff-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Referee Sign-Off</div>
        <div class="lb-event">{{ event?.name }}</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="close">Close ✕</button>
    </div>
    <div class="lb-body">
      <!-- Enforcement banner: visible when the event was created
           with enforce_referee_signoff = TRUE so the operator
           understands why the manager-attests tab isn't there. -->
      <div v-if="enforceSignoff" class="signoff-enforced-banner">
        🔒 Referee sign-off is enforced for this event. Only the
        referee's own approval — push, code, or credential — counts.
      </div>

      <!-- Tab strip — push (primary), Cut 3 code, credential
           (fallback at this device), and the manager-attests
           shortcut (hidden when sign-off is enforced). -->
      <div class="signoff-tabs">
        <button :class="['signoff-tab', signoffMode === 'push' ? 'is-active' : '']"
                @click="signoffMode = 'push'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode"
                v-tip="(!!signoffWaiting || !!signoffCode)
                  ? 'A request is already pending — close it (Cancel) before switching modes'
                  : 'Push a notification to the referee’s phone for them to approve'">
          📱 Send to referee's device
        </button>
        <button :class="['signoff-tab', signoffMode === 'code' ? 'is-active' : '']"
                @click="signoffMode = 'code'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode"
                v-tip="(!!signoffWaiting || !!signoffCode)
                  ? 'A request is already pending — close it (Cancel) before switching modes'
                  : 'Generate a 6-digit code + QR for the referee to enter on their phone'">
          🔢 Code on referee's device
        </button>
        <button :class="['signoff-tab', signoffMode === 'credential' ? 'is-active' : '']"
                @click="signoffMode = 'credential'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode"
                v-tip="(!!signoffWaiting || !!signoffCode)
                  ? 'A request is already pending — close it (Cancel) before switching modes'
                  : 'Hand the laptop to the referee — they sign in with their own credentials'">
          🔐 Sign at this device
        </button>
        <button v-if="!enforceSignoff"
                :class="['signoff-tab', signoffMode === 'manager' ? 'is-active' : '']"
                @click="signoffMode = 'manager'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode">
          ✓ I'll attest
        </button>
      </div>

      <!-- Push path -->
      <div v-if="signoffMode === 'push'" class="signoff-pane">
        <p class="hint">
          Pick the referee — they'll get a push notification on their phone /
          laptop with Approve / Deny buttons. The request times out after 5
          minutes. If they can't get the notification, switch to the other
          tab to sign on this device.
        </p>
        <template v-if="!signoffWaiting">
          <div v-if="!signoffReferees.length" class="empty-mini">
            No referees in this org yet. Use the credential tab instead.
          </div>
          <select v-else class="select" v-model="signoffPickedRefId" :disabled="busy">
            <option value="">— Pick a referee —</option>
            <option v-for="r in signoffReferees" :key="r.id" :value="r.id">
              {{ r.full_name }}
            </option>
          </select>
          <div class="signoff-actions">
            <button class="btn btn-primary"
                    :disabled="busy || !signoffPickedRefId"
                    v-tip="!signoffPickedRefId ? 'Select a referee from the list above first' : ''"
                    @click="sendSignoffPush">
              {{ busy ? 'Sending…' : 'Send sign-off request' }}
            </button>
          </div>
        </template>
        <div v-else class="signoff-waiting">
          <div class="signoff-waiting-pulse">●</div>
          Waiting for {{ signoffWaiting.referee_name }} to approve…
          <div class="signoff-waiting-hint">
            Or switch tabs and have them sign here on this device.
          </div>
        </div>
      </div>

      <!-- Code path (Cut 3) -->
      <div v-else-if="signoffMode === 'code'" class="signoff-pane">
        <p class="hint">
          Pick the referee. Server generates a 6-digit code; read it to
          the referee, who types it on their own device at
          <code>/sign-off-codes</code>. The code is good for 5 minutes.
        </p>
        <template v-if="!signoffCode">
          <div v-if="!signoffReferees.length" class="empty-mini">
            No referees in this org yet.
          </div>
          <select v-else class="select" v-model="signoffPickedRefId" :disabled="busy">
            <option value="">— Pick a referee —</option>
            <option v-for="r in signoffReferees" :key="r.id" :value="r.id">
              {{ r.full_name }}
            </option>
          </select>
          <div class="signoff-actions">
            <button class="btn btn-primary"
                    :disabled="busy || !signoffPickedRefId"
                    v-tip="!signoffPickedRefId ? 'Select a referee from the list above first' : ''"
                    @click="generateSignoffCode">
              {{ busy ? 'Generating…' : 'Generate code' }}
            </button>
          </div>
        </template>
        <div v-else class="signoff-code-display">
          <div class="signoff-code-label">Show this to {{ signoffCode.referee_name }}</div>
          <!-- Two-column hand-off: QR on the left, typeable code
               on the right. Whichever the referee can use first
               wins — both feed the same /sign-off/code/verify
               endpoint, so this panel updates the moment either
               path completes. The QR encodes the same code as a
               deep link into /sign-off-codes; scan-then-tap is
               faster than dictating six digits across a venue. -->
          <div class="signoff-code-grid">
            <div v-if="signoffCode.qr_data_url" class="signoff-code-qr-block">
              <img
                class="signoff-code-qr"
                :src="signoffCode.qr_data_url"
                alt="QR code for referee sign-off"
              />
              <div class="signoff-code-qr-caption">Scan to sign off</div>
            </div>
            <div class="signoff-code-divider" v-if="signoffCode.qr_data_url">or</div>
            <div class="signoff-code-text-block">
              <div class="signoff-code-value">{{ signoffCode.code }}</div>
              <div class="signoff-code-text-caption">Enter at <code>/sign-off-codes</code></div>
            </div>
          </div>
          <div class="signoff-code-hint">
            This panel updates the moment {{ signoffCode.referee_name }} confirms — by scan or
            by code.
          </div>
        </div>
      </div>

      <!-- Manager-attests path. Hidden in template when enforced;
           server gate refuses too. -->
      <div v-else-if="signoffMode === 'manager'" class="signoff-pane">
        <p class="hint">
          You're attesting that you've already confirmed the dive order
          with the referee verbally. Your name is what gets stamped on
          the audit trail — pick this only when you've genuinely got
          the referee's go-ahead.
        </p>
        <div class="signoff-actions">
          <button class="btn btn-primary"
                  :disabled="busy"
                  @click="managerAttestSignoff">
            {{ busy ? 'Recording…' : "I'll attest — sign off" }}
          </button>
        </div>
      </div>

      <!-- Credential path -->
      <div v-else class="signoff-pane">
        <p class="hint">
          Hand the laptop to the referee. They sign in with their own
          username + password (and TOTP if enabled). Your manager session
          stays put.
        </p>
        <div class="cred-fields">
          <div class="field">
            <label class="label">Referee username</label>
            <input class="input" type="text" v-model="credUsername"
                   autocomplete="off" :disabled="busy">
          </div>
          <div class="field">
            <label class="label">Password</label>
            <!-- current-password (not new-password): this is a re-auth
                 prompt for an EXISTING referee account, not a new-account
                 creation form. iOS Safari only surfaces AutoFill on
                 current-password fields; new-password suppresses it and
                 forces manual entry of a (usually complex) referee
                 password on a borrowed device mid-meet. -->
            <input class="input" type="password" v-model="credPassword"
                   autocomplete="current-password" :disabled="busy">
          </div>
          <div v-if="credNeedsTotp" class="field">
            <label class="label">TOTP / recovery code</label>
            <input class="input" type="text" v-model="credCode"
                   autocomplete="one-time-code" inputmode="numeric"
                   :disabled="busy">
          </div>
        </div>
        <div class="signoff-actions">
          <button class="btn btn-primary"
                  :disabled="busy || !credUsername.trim() || !credPassword"
                  v-tip="!credUsername.trim() ? 'Enter the referee’s username'
                    : (!credPassword ? 'Enter the referee’s password' : '')"
                  @click="submitCredentialSignoff">
            {{ busy ? 'Verifying…' : 'Sign off' }}
          </button>
        </div>
      </div>

      <div v-if="signoffError" class="msg msg-error">{{ signoffError }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Sign-off styles MOVED from ControlView.css (exclusive to this
   modal). The .lb-* modal frame below is COPIED — the pattern is
   shared by the modals that remain in ControlView. */
.signoff-modal { max-width: 540px; }
.signoff-tabs {
  display: flex; gap: 0.4rem; margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.signoff-tab {
  flex: 1; padding: 0.6rem 0.8rem; cursor: pointer;
  background: transparent; border: none;
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.06em; color: var(--text-3);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.signoff-tab:hover:not(:disabled) { color: var(--text-2); }
.signoff-tab.is-active { color: var(--cyan); border-bottom-color: var(--cyan); }
.signoff-tab:disabled { opacity: 0.5; cursor: not-allowed; }
.signoff-pane { padding: 0.4rem 0; }
.signoff-pane .hint { color: var(--text-3); font-size: 12.5px; line-height: 1.6; margin-bottom: 1rem; }
.signoff-pane .select { width: 100%; }
.cred-fields { display: flex; flex-direction: column; gap: 0.7rem; margin-bottom: 1rem; }
.signoff-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
.signoff-waiting {
  text-align: center; padding: 2rem 1rem; color: var(--amber);
  font-family: var(--font-sans); font-size: 14px; font-style: normal;
}
.signoff-waiting-pulse {
  font-size: 28px; line-height: 1;
  animation: signoff-pulse 1.5s ease-in-out infinite;
  margin-bottom: 0.5rem;
}
.signoff-waiting-hint {
  margin-top: 0.7rem; font-size: 11.5px; color: var(--text-3);
  font-style: normal;
}
/* Cut 3 code display — QR on the left, big monospace digits on
   the right. Two-column flex with a vertical "or" divider in
   between; collapses to a vertical stack on narrow modals. */
.signoff-code-display {
  text-align: center; padding: 1.2rem 0.5rem;
}
.signoff-code-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.9rem;
}
.signoff-code-grid {
  display: flex; align-items: center; justify-content: center;
  gap: 1.2rem; flex-wrap: wrap;
  margin-bottom: 1rem;
}
.signoff-code-qr-block,
.signoff-code-text-block {
  display: flex; flex-direction: column; align-items: center;
  gap: 0.4rem;
}
/* The QR <img> is rendered server-side at 256×256 px; constrain
   here so it sits comfortably inside the modal but stays large
   enough to scan from across a venue. White background keeps
   the QR contrast readable on the modal's dark surface. */
.signoff-code-qr {
  width: 180px; height: 180px;
  background: #fff; padding: 8px;
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--border);
}
.signoff-code-qr-caption,
.signoff-code-text-caption {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3);
}
.signoff-code-text-caption code {
  background: var(--bg-3); padding: 0.05rem 0.35rem;
  border-radius: 3px; font-size: 10px;
  font-family: var(--font-mono); color: var(--text-2);
  letter-spacing: 0;
}
.signoff-code-divider {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  padding: 0 0.5rem;
}
.signoff-code-value {
  font-family: var(--font-mono); font-size: 44px; font-weight: 800;
  letter-spacing: 0.18em; color: var(--cyan); line-height: 1;
}
.signoff-code-hint {
  font-size: 11.5px; color: var(--text-3); line-height: 1.5;
}
.signoff-code-hint code {
  background: var(--bg-3); padding: 0.05rem 0.35rem;
  border-radius: 3px; font-size: 11px;
}
.signoff-enforced-banner {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: var(--amber);
  border-radius: 4px; padding: 0.6rem 0.8rem;
  font-size: 12.5px; line-height: 1.45;
  margin-bottom: 0.8rem;
}
@keyframes signoff-pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50%      { opacity: 1;   transform: scale(1.15); }
}

/* Modal frame — copied from ControlView.css (see AGENTS.md
   "Modal CSS pattern": fixed backdrop + sibling fixed modal). */
.lb-backdrop { position: fixed; inset: 0; background: rgba(3,7,18,0.95); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); z-index: 300; }
.lb-modal {
  position: fixed; top: 50%; inset-inline-start: 50%; transform: translate(-50%, -50%);
  z-index: 301;
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 28px;
  width: calc(100% - 3rem); max-width: 560px;
  max-height: 90vh;
  max-height: 90dvh;
  overflow-y: auto; animation: fadeUp 0.3s ease;
  overflow-x: clip;
  box-shadow: 0 30px 60px rgba(0,0,0,0.55);
}
.lb-header { padding: 2rem 2rem 1.25rem; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); display: flex; align-items: flex-start; justify-content: space-between; }
.lb-title { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.4rem; }
.lb-event { font-family: var(--font-sans); font-size: 22px; font-weight: 600; font-style: normal; letter-spacing: -0.015em; color: var(--fg); line-height: 1.1; }
.lb-body { padding: 1.5rem 2rem 2rem; }
@media (max-width: 720px) {
  .lb-modal {
    max-height: calc(100vh - 1.5rem);   /* fallback */
    max-height: calc(100dvh - 1.5rem);  /* preferred */
    border-radius: var(--radius-lg);
  }
  .lb-header  { padding: 1.25rem 1.25rem 1rem; }
  .lb-event   { font-size: 22px; }
  .lb-body    { padding: 1rem 1.25rem 1.5rem; }
}
</style>
