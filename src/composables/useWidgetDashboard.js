// The self-serve widget dashboard shared by the diver profile and the
// judge analysis page: which widgets are on and in what order, the
// Customise modal's drag-to-reorder list, the date-range filter and the
// print button. Both views carried their own copy of all of this and only
// the catalog, the default set and the save URL differed, so those are
// what a caller passes in.
//
// Takes the auth store rather than importing it, so
// test/use-widget-dashboard.test.js can run it under plain node (no '@/'
// alias there). Only auth.apiFetch is used.
import { ref, computed } from 'vue'

export function useWidgetDashboard({ auth, catalog, defaults, saveUrl, profile, isSelf, reload }) {
  const customizing = ref(false)
  const customizeSaving = ref(false)
  const customizeErr = ref('')
  // Index of the widget being dragged in the Customise modal, or null.
  // Drives the drop-target styling and the re-order on drop.
  const dragIndex = ref(null)
  const dragOverIndex = ref(null)
  // Date-range filter. Empty strings mean no filter on that side.
  const fromDate = ref('')
  const toDate = ref('')

  const enabledWidgets = computed(() =>
    Array.isArray(profile.value?.dashboard_widgets) ? profile.value.dashboard_widgets : defaults,
  )
  // Display order mirrors the saved order, minus anything no longer in
  // the catalog (so removing a widget later doesn't leave a ghost entry).
  const orderedEnabled = computed(() => {
    const known = new Set(catalog.map(w => w.id))
    return enabledWidgets.value.filter(id => known.has(id))
  })
  function isEnabled(id) { return enabledWidgets.value.includes(id) }
  // Feeds each card's inline `order`, so the page follows the saved drag
  // order without repeating the whole template inside a v-for.
  function widgetOrder(id) {
    const idx = orderedEnabled.value.indexOf(id)
    return idx === -1 ? 999 : idx
  }

  // The Customise modal works on a complete, stable list: enabled widgets
  // first in saved order, then the rest in catalog order.
  const customizeList = computed(() => {
    const enabledSet = new Set(enabledWidgets.value)
    const enabledOrdered = enabledWidgets.value
      .filter(id => enabledSet.has(id))
      .map(id => catalog.find(w => w.id === id))
      .filter(Boolean)
    const disabled = catalog.filter(w => !enabledSet.has(w.id))
    return [...enabledOrdered, ...disabled]
  })

  async function saveWidgets(next) {
    customizeSaving.value = true
    customizeErr.value = ''
    try {
      const r = await auth.apiFetch(saveUrl, {
        method: 'PUT',
        body: JSON.stringify({ widgets: next }),
      })
      profile.value.dashboard_widgets = r.widgets
    } catch (err) {
      customizeErr.value = err.message || 'Save failed'
    } finally {
      customizeSaving.value = false
    }
  }
  async function toggleWidget(id) {
    if (!isSelf.value) return
    const next = isEnabled(id)
      ? enabledWidgets.value.filter(w => w !== id)
      : [...enabledWidgets.value, id]
    await saveWidgets(next)
  }

  function onDragStart(idx, ev) {
    dragIndex.value = idx
    // Firefox won't start a drag without some data set.
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move'
      try { ev.dataTransfer.setData('text/plain', String(idx)) } catch { /* ignore */ }
    }
  }
  function onDragOver(idx, ev) {
    if (dragIndex.value == null) return
    ev.preventDefault()  // allow drop
    dragOverIndex.value = idx
  }
  function onDragLeave(idx) {
    if (dragOverIndex.value === idx) dragOverIndex.value = null
  }
  async function onDrop(idx, ev) {
    ev.preventDefault()
    const from = dragIndex.value
    dragIndex.value = null
    dragOverIndex.value = null
    if (from == null || from === idx) return
    // Move within the full list (drags cross enabled and disabled rows),
    // then persist only the enabled ids in their new order.
    const list = customizeList.value.slice()
    const [moved] = list.splice(from, 1)
    list.splice(idx, 0, moved)
    const enabledSet = new Set(enabledWidgets.value)
    const next = list.map(w => w.id).filter(id => enabledSet.has(id))
    await saveWidgets(next)
  }
  function onDragEnd() {
    dragIndex.value = null
    dragOverIndex.value = null
  }

  // Query string for the profile and analytics requests: empty with no
  // filter, otherwise with its leading "?".
  function dateQS() {
    const parts = []
    if (fromDate.value) parts.push(`from_date=${encodeURIComponent(fromDate.value)}`)
    if (toDate.value) parts.push(`to_date=${encodeURIComponent(toDate.value)}`)
    return parts.length ? `?${parts.join('&')}` : ''
  }
  // Apply is a button, so a half-typed date doesn't fire a request
  // mid-keystroke.
  async function applyDateFilter() {
    await reload()
  }
  function clearDateFilter() {
    fromDate.value = ''
    toDate.value = ''
    reload()
  }

  // Print / "save as PDF" through the browser's dialog and the @media
  // print stylesheet. The body class also covers a dismissed dialog (say
  // the user screenshots instead); afterprint takes it off again.
  function exportPDF() {
    document.body.classList.add('printing-dashboard')
    const cleanup = () => {
      document.body.classList.remove('printing-dashboard')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    // Next frame, so the class lands before the print snapshot.
    requestAnimationFrame(() => window.print())
  }

  return {
    customizing, customizeSaving, customizeErr, dragIndex, dragOverIndex, fromDate, toDate,
    enabledWidgets, orderedEnabled, isEnabled, widgetOrder, customizeList,
    saveWidgets, toggleWidget, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
    dateQS, applyDateFilter, clearDateFilter, exportPDF,
  }
}
