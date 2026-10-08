// Serialize idle-timer changes: leaving a screen during lazy plugin loading
// must end with the timer enabled again, not a late keep-awake request.
export function createAwakeController(loadPlugin) {
  let pending = Promise.resolve()
  return {
    set(enabled) {
      pending = pending.catch(() => {}).then(async () => {
        const plugin = await loadPlugin()
        await plugin.setKeepAwake({ enabled: Boolean(enabled) })
      })
      return pending
    },
  }
}
