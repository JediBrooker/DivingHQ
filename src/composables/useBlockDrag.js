// useBlockDrag, the Phase 3 helper for the SchedulerView timeline.
//
// One factory per session timeline. Returns three event-handler
// builders the template wires onto each block:
//
//   * `startMove(event, block)`: vertical drag shifts the
//     whole window in time, horizontal drag re-assigns the
//     block to a new board column (uuid[]).
//   * `startResizeTop(event, block)`: drag the top edge to
//     change `starts_at` only.
//   * `startResizeBottom(event, block)`: drag the bottom edge to
//     change `ends_at` only.
//
// All three converge on the same `onPointerMove` math:
//
//   delta_minutes = (pixel_delta / pixelsPerMinute)
//   snap_step     = shiftKey ? 5 : 30
//   delta_minutes = round(delta_minutes / snap_step) * snap_step
//
// The drag is a *preview* until the operator releases the pointer:
// the ref returned by `dragState` exposes a candidate `{ blockId,
// preview }` the template uses to render the block at its in-flight
// position. On pointerup we call the caller-supplied `commit`
// callback with `{ block, patch }` (patch is the subset of fields
// that actually changed), and the SchedulerView turns that into a
// PUT /api/blocks/:id.
//
// We deliberately didn't pull in a drag library for this. The math
// above is the whole thing, the rest is just bookkeeping for the
// shift-key snap and the cancel-on-Escape affordance.

import { ref } from 'vue'

const ESCAPE_KEY = 'Escape'

export function useBlockDrag({
  pixelsPerMinute,
  defaultSnapMinutes = 30,
  fineSnapMinutes = 5,
  // Resolve the board column under a pointer x coordinate. Returns
  // the new board_ids array, or null to leave board_ids unchanged.
  // Pass null/undefined to disable horizontal column reassignment
  // entirely (used by resize handles, since they never touch boards).
  resolveColumnAtX = null,
  // Called with { block, patch } when a drag commits. Patch is a
  // partial { starts_at, ends_at, board_ids }, only the keys that
  // actually changed are included.
  commit,
}) {
  // dragState is reactive so the template can render the in-flight
  // preview without re-running the gesture handlers. Shape:
  //   null          - no drag in progress
  //   { blockId, mode: 'move' | 'resize_top' | 'resize_bottom',
  //     preview: { starts_at, ends_at, board_ids } }
  const dragState = ref(null)

  // Internal handles to clean up listeners on pointerup / Escape.
  // Stored on a module-scope object rather than reactive refs to
  // avoid Vue tracking work on every mousemove.
  let active = null

  function snapMinutes(rawMin, fine) {
    const step = fine ? fineSnapMinutes : defaultSnapMinutes
    // Round-to-nearest so the operator gets visual feedback that
    // matches the gridline they're hovering over, floor would just
    // make a drag "stick" one step behind the cursor.
    return Math.round(rawMin / step) * step
  }

  function diffPatch(original, preview) {
    const out = {}
    const sa = new Date(original.starts_at).getTime()
    const ea = new Date(original.ends_at).getTime()
    const ps = new Date(preview.starts_at).getTime()
    const pe = new Date(preview.ends_at).getTime()
    if (ps !== sa) out.starts_at = new Date(ps).toISOString()
    if (pe !== ea) out.ends_at = new Date(pe).toISOString()
    if (preview.board_ids !== undefined && !sameArray(preview.board_ids, original.board_ids || [])) {
      out.board_ids = preview.board_ids
    }
    return out
  }

  function sameArray(a, b) {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  function cancel() {
    if (!active) return
    document.removeEventListener('pointermove', active.onMove)
    document.removeEventListener('pointerup', active.onUp)
    document.removeEventListener('keydown', active.onKey)
    active = null
    dragState.value = null
  }

  function beginGesture({ event, block, mode }) {
    if (active) return
    // Only respond to the primary button, right-clicks and middle-
    // clicks should keep their browser-default behaviour (context
    // menu, scroll-anchor) instead of accidentally moving a block.
    if (event.button != null && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    const startX = event.clientX
    const startY = event.clientY
    const original = {
      starts_at: block.starts_at,
      ends_at: block.ends_at,
      board_ids: Array.isArray(block.board_ids) ? block.board_ids.slice() : [],
    }
    const originalStartMs = new Date(original.starts_at).getTime()
    const originalEndMs = new Date(original.ends_at).getTime()
    const ppm = typeof pixelsPerMinute === 'function' ? pixelsPerMinute() : pixelsPerMinute

    function onMove(e) {
      const dyPx = e.clientY - startY
      const dxPx = e.clientX - startX
      const dyMin = dyPx / ppm
      const snapped = snapMinutes(dyMin, e.shiftKey)
      const deltaMs = snapped * 60 * 1000

      let nextStart = originalStartMs
      let nextEnd = originalEndMs
      if (mode === 'move') {
        nextStart = originalStartMs + deltaMs
        nextEnd = originalEndMs + deltaMs
      } else if (mode === 'resize_top') {
        nextStart = originalStartMs + deltaMs
        // never let the top edge cross the bottom edge, clamp to
        // one snap-step below the end
        const minStep = (e.shiftKey ? fineSnapMinutes : defaultSnapMinutes) * 60 * 1000
        if (nextStart > originalEndMs - minStep) nextStart = originalEndMs - minStep
      } else if (mode === 'resize_bottom') {
        nextEnd = originalEndMs + deltaMs
        const minStep = (e.shiftKey ? fineSnapMinutes : defaultSnapMinutes) * 60 * 1000
        if (nextEnd < originalStartMs + minStep) nextEnd = originalStartMs + minStep
      }

      let nextBoards = original.board_ids
      if (mode === 'move' && typeof resolveColumnAtX === 'function') {
        const resolved = resolveColumnAtX(e.clientX, dxPx, block)
        if (Array.isArray(resolved)) nextBoards = resolved
      }

      dragState.value = {
        blockId: block.id,
        mode,
        preview: {
          starts_at: new Date(nextStart).toISOString(),
          ends_at: new Date(nextEnd).toISOString(),
          board_ids: nextBoards,
        },
      }
    }

    async function onUp() {
      const state = dragState.value
      cancel()
      if (!state || state.blockId !== block.id) return
      const patch = diffPatch(original, state.preview)
      if (Object.keys(patch).length === 0) return
      try {
        await commit({ block, patch })
      } catch (_e) {
        // The SchedulerView surfaces the error inline, so we don't
        // need to double-report here. Just in case, we still want to
        // make sure the preview is cleared so the block snaps back to
        // its pre-drag position on a failed save.
      }
    }

    function onKey(e) {
      if (e.key === ESCAPE_KEY) cancel()
    }

    active = { onMove, onUp, onKey }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp, { once: true })
    document.addEventListener('keydown', onKey)
  }

  function startMove(event, block) {
    beginGesture({ event, block, mode: 'move' })
  }
  function startResizeTop(event, block) {
    beginGesture({ event, block, mode: 'resize_top' })
  }
  function startResizeBottom(event, block) {
    beginGesture({ event, block, mode: 'resize_bottom' })
  }

  return {
    dragState,
    startMove,
    startResizeTop,
    startResizeBottom,
    cancel,
  }
}
