// Shared dive-directory search/filter.
//
// CompetitorView, TeamDiveListView and CoachDiveListsView each
// offer a "pick a dive from the directory" UI, and each used to
// carry its own copy of the same filter (code+position text match,
// height restriction, result cap). Now there's one implementation,
// with per-view differences expressed as options:
//
//   term   - Ref<string> bound to a search input. Matches the
//            concatenated code+position ("101C") and the
//            description, case-insensitively. Omit for views
//            with no text search (CoachDiveListsView's flat
//            dropdown).
//   height - Ref<number|null>. When non-null, only dives at
//            exactly that height pass.
//   limit  - caps result count (search pickers keep their
//            dropdowns short). Omit for no cap.
//   sort   - orders results by dive_code then position (the flat
//            dropdown wants alphabetical, the search pickers just
//            keep directory order).
//
// Returns a computed array of matching directory rows.

import { computed, unref } from 'vue'

export function useDiveSearch(directory, { term = null, height = null, limit = null, sort = false } = {}) {
  return computed(() => {
    const q = term ? String(unref(term) || '').trim().toLowerCase() : ''
    const h = height ? unref(height) : null
    const results = unref(directory).filter((d) => {
      if (h != null && parseFloat(d.height) !== h) return false
      if (!q) return true
      return (d.dive_code + d.position).toLowerCase().includes(q)
        || (d.description || '').toLowerCase().includes(q)
    })
    if (sort) {
      results.sort((a, b) =>
        a.dive_code.localeCompare(b.dive_code)
        || (a.position || '').localeCompare(b.position || ''))
    }
    return limit != null ? results.slice(0, limit) : results
  })
}
