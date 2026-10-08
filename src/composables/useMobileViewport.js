import { onMounted, onBeforeUnmount, ref } from 'vue'

// visualViewport follows the visible area above an on-screen keyboard. Keep
// the shell's scroll surface there instead of placing focused controls behind
// the keyboard. An editable focus is required so browser zoom isn't mistaken
// for keyboard presentation.
export function useMobileViewport() {
  const keyboardOpen = ref(false)
  const viewportHeight = ref(null)
  let frame
  let baseline = 0
  let orientation = ''
  function update() {
    const nextOrientation = window.matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait'
    if (orientation !== nextOrientation) { orientation = nextOrientation; baseline = window.innerHeight }
    const viewport = window.visualViewport
    const editable = document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]')
    if (!editable) baseline = window.innerHeight
    else baseline = Math.max(baseline, window.innerHeight)
    const height = viewport?.height || window.innerHeight
    keyboardOpen.value = Boolean(editable && baseline - height > 120 && (!viewport || viewport.scale === 1))
    // Do not resize the app during accessibility pinch zoom.
    viewportHeight.value = keyboardOpen.value ? Math.round(height) : null
    if (keyboardOpen.value) {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => document.activeElement?.scrollIntoView({ block: 'nearest' }))
    }
  }
  onMounted(() => {
    update()
    window.visualViewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
  })
  onBeforeUnmount(() => {
    cancelAnimationFrame(frame)
    window.visualViewport?.removeEventListener('resize', update)
    window.removeEventListener('resize', update)
    document.removeEventListener('focusin', update)
    document.removeEventListener('focusout', update)
  })
  return { keyboardOpen, viewportHeight }
}
