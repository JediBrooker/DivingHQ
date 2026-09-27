// useWidgetDashboard, the widget toggles / drag order / date filter the
// diver profile and the judge analysis page share. DB-less, runs in
// test:safe. A fake auth store stands in for the PUT that saves a layout.
const { test, before } = require('node:test')
const assert = require('node:assert/strict')

let useWidgetDashboard, ref, computed

before(async () => {
  ;({ useWidgetDashboard } = await import('../src/composables/useWidgetDashboard.js'))
  ;({ ref, computed } = await import('vue'))
})

const CATALOG = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase() }))

function setup({ widgets, self = true, fail = null } = {}) {
  const puts = []
  const auth = {
    async apiFetch(url, opts) {
      if (fail) throw fail
      const body = JSON.parse(opts.body)
      puts.push({ url, widgets: body.widgets })
      return { widgets: body.widgets }
    },
  }
  const profile = ref(widgets === undefined ? {} : { dashboard_widgets: widgets })
  let reloads = 0
  const d = useWidgetDashboard({
    auth,
    catalog: CATALOG,
    defaults: ['a', 'b'],
    saveUrl: '/api/users/me/dashboard',
    profile,
    isSelf: computed(() => self),
    reload: async () => { reloads++ },
  })
  return { d, puts, profile, reloads: () => reloads }
}

const dragEvent = () => ({ preventDefault() {}, dataTransfer: null })

test('falls back to the defaults, and drops ids the catalog no longer has', () => {
  assert.deepEqual(setup().d.enabledWidgets.value, ['a', 'b'])
  const { d } = setup({ widgets: ['c', 'gone', 'a'] })
  assert.deepEqual(d.orderedEnabled.value, ['c', 'a'])
  assert.equal(d.widgetOrder('a'), 1)
  assert.equal(d.widgetOrder('b'), 999)
})

test('the Customise list puts enabled widgets first, in saved order', () => {
  const { d } = setup({ widgets: ['c', 'a'] })
  assert.deepEqual(d.customizeList.value.map((w) => w.id), ['c', 'a', 'b', 'd'])
})

test('toggling saves the new set and takes what the server returns', async () => {
  const { d, puts, profile } = setup({ widgets: ['a'] })
  await d.toggleWidget('c')
  assert.deepEqual(puts, [{ url: '/api/users/me/dashboard', widgets: ['a', 'c'] }])
  assert.deepEqual(profile.value.dashboard_widgets, ['a', 'c'])
  await d.toggleWidget('a')
  assert.deepEqual(puts.at(-1).widgets, ['c'])
})

test('someone else\'s dashboard can\'t be toggled', async () => {
  const { d, puts } = setup({ widgets: ['a'], self: false })
  await d.toggleWidget('b')
  assert.deepEqual(puts, [])
})

test('a drop moves across the whole list but only saves enabled ids', async () => {
  const { d, puts } = setup({ widgets: ['a', 'b'] })
  // list is a, b, c, d: drag "a" onto the "c" slot (disabled row)
  d.onDragStart(0, dragEvent())
  d.onDragOver(2, dragEvent())
  assert.equal(d.dragOverIndex.value, 2)
  await d.onDrop(2, dragEvent())
  assert.deepEqual(puts.at(-1).widgets, ['b', 'a'])
  assert.equal(d.dragIndex.value, null)
  assert.equal(d.dragOverIndex.value, null)
})

test('a drop onto itself saves nothing', async () => {
  const { d, puts } = setup({ widgets: ['a', 'b'] })
  d.onDragStart(1, dragEvent())
  await d.onDrop(1, dragEvent())
  assert.deepEqual(puts, [])
})

test('a failed save keeps the layout and reports the error', async () => {
  const { d, profile } = setup({ widgets: ['a'], fail: new Error('nope') })
  await d.toggleWidget('b')
  assert.equal(d.customizeErr.value, 'nope')
  assert.equal(d.customizeSaving.value, false)
  assert.deepEqual(profile.value.dashboard_widgets, ['a'])
})

test('the date filter builds its query string and clearing reloads', async () => {
  const { d, reloads } = setup()
  assert.equal(d.dateQS(), '')
  d.fromDate.value = '2026-01-01'
  assert.equal(d.dateQS(), '?from_date=2026-01-01')
  d.toDate.value = '2026-02-01'
  assert.equal(d.dateQS(), '?from_date=2026-01-01&to_date=2026-02-01')
  await d.applyDateFilter()
  d.clearDateFilter()
  assert.equal(d.dateQS(), '')
  assert.equal(reloads(), 2)
})
