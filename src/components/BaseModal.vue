<script setup>
// One a11y-correct dialog primitive (P2 of the meet-day redesign).
// Reuses the shared lb-* frame (kept in ControlView.css until the last
// consumer migrates) and adds the focus management the 7 standalone
// control modals never had: focus-on-open, Tab / Shift+Tab trap,
// Esc-to-close, and focus-restore to the element that opened it.
// Modelled on ConfirmModal.vue's a11y pattern.
//
// Supports both consumer styles the Control Room uses:
//   v-if   -> parent mounts/unmounts; `open` defaults to true.
//   :open  -> always-mounted; parent toggles `open` (LateEntry's
//             cache-survival contract).
//
// Scroll-lock is intentionally NOT owned here -- ControlView's 14-flag
// useBodyScrollLock OR reference-counts it across every surface.
import { ref, computed, watch, nextTick, onBeforeUnmount, useId } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: true },
  // id of the element that labels the dialog; ModalHeader wires this
  // to its title via the slot-scoped `titleId`.
  labelledby: { type: String, default: '' },
  maxWidth: { type: String, default: '' },
  closeOnBackdrop: { type: Boolean, default: true },
  closeOnEsc: { type: Boolean, default: true },
})
const emit = defineEmits(['close', 'update:open'])

const modalRef = ref(null)
const uid = useId()
const titleId = computed(() => props.labelledby || `basemodal-title-${uid}`)
let lastFocused = null

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusable() {
  if (!modalRef.value) return []
  return [...modalRef.value.querySelectorAll(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

function close() {
  emit('close')
  emit('update:open', false)
}
function onBackdrop() {
  if (props.closeOnBackdrop) close()
}

function onKeydown(e) {
  if (!props.open) return
  if (e.key === 'Escape' && props.closeOnEsc) {
    e.preventDefault()
    close()
    return
  }
  if (e.key !== 'Tab') return
  const els = focusable()
  if (!els.length) {
    e.preventDefault()
    modalRef.value?.focus()
    return
  }
  const first = els[0]
  const last = els[els.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

function activate() {
  lastFocused = document.activeElement
  document.addEventListener('keydown', onKeydown, true)
  nextTick(() => {
    const els = focusable()
    ;(els[0] || modalRef.value)?.focus()
  })
}
function deactivate() {
  document.removeEventListener('keydown', onKeydown, true)
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
  lastFocused = null
}

watch(
  () => props.open,
  (open) => {
    if (open) activate()
    else deactivate()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  // Covers v-if consumers that unmount instead of toggling `open`.
  document.removeEventListener('keydown', onKeydown, true)
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus()
})
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="lb-backdrop" @mousedown.self="onBackdrop"></div>
      <div
        ref="modalRef"
        class="lb-modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :style="maxWidth ? { maxWidth } : null"
        tabindex="-1"
      >
        <slot :title-id="titleId" />
      </div>
    </template>
  </Teleport>
</template>
