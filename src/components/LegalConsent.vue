<script setup>
// The one line under the sign-up buttons on /register and /register-org:
// "By creating an account you agree to the Terms and Privacy Policy."
//
// A component rather than markup in both forms so the wording and links
// stay identical, and it's registered globally in main.js so each form only
// needs the single <LegalConsent /> line. Both links open in a new tab, so
// reading the policy doesn't throw away a half-filled form.
import { RouterLink } from 'vue-router'
</script>

<template>
  <i18n-t keypath="legal.consent" tag="p" class="legal-consent" data-testid="legal-consent">
    <template #terms>
      <RouterLink to="/terms" target="_blank" rel="noopener">{{ $t('legal.terms_title') }}</RouterLink>
    </template>
    <template #privacy>
      <RouterLink to="/privacy" target="_blank" rel="noopener">{{ $t('legal.privacy_title') }}</RouterLink>
    </template>
  </i18n-t>
</template>

<style scoped>
.legal-consent {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  color: var(--fg-3);
}
.legal-consent a {
  color: var(--accent);
  text-decoration: none;
}
.legal-consent a:hover { text-decoration: underline; }
</style>
