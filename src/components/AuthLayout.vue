<template>
  <div class="auth-layout"><slot /></div>
</template>

<style scoped>
/* Auth screens own their scroll area. Styling body from a lazy-loaded view
   leaves that layout behind after login and can clip the next standalone page.
   Auto margins center a short form and become zero for tall forms/keyboards. */
.auth-layout {
  position: fixed;
  inset: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: max(24px, env(safe-area-inset-top, 0px));
  padding-right: max(24px, env(safe-area-inset-right, 0px));
  padding-bottom: max(24px, env(safe-area-inset-bottom, 0px));
  padding-left: max(24px, env(safe-area-inset-left, 0px));
  background: var(--bg);
}
.auth-layout > :deep(*) { flex-shrink: 0; margin-block: auto; }
</style>
