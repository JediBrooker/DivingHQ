const { test } = require('node:test')
const assert = require('node:assert/strict')
test('leaving during native plugin loading releases the idle timer last', async () => {
  const { createAwakeController } = await import('../src/lib/native-poolside.mjs')
  const writes = []
  let resolveLoad
  const ready = new Promise(resolve => { resolveLoad = resolve })
  const controller = createAwakeController(async () => { await ready; return { setKeepAwake: ({ enabled }) => { writes.push(enabled) } } })
  const enter = controller.set(true)
  const leave = controller.set(false)
  resolveLoad()
  await Promise.all([enter, leave])
  assert.deepEqual(writes, [true, false])
})
test('native timer release still runs after an enable failure', async () => {
  const { createAwakeController } = await import('../src/lib/native-poolside.mjs')
  const writes = []
  const controller = createAwakeController(async () => ({ setKeepAwake: ({ enabled }) => { if (enabled) throw new Error('enable failed'); writes.push(enabled) } }))
  await assert.rejects(controller.set(true), /enable failed/)
  await controller.set(false)
  assert.deepEqual(writes, [false])
})
