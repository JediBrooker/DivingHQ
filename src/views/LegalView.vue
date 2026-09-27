<script setup>
// /privacy and /terms, public.
//
// The text is docs/privacy-policy.md and docs/terms-of-service.md, imported
// raw the same way the guide imports its topics. One source, so the policy in
// the repo and the one people agree to at sign-up can't drift apart.
//
// Body text stays English on purpose: it's legal text, and a machine
// translation that says something slightly different would be worse than
// none. Non-English readers get a one-line note saying so. The chrome around
// it (top bar, footer, the note) is translated like everything else.
import { computed, watch, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import privacyMd from '../../docs/privacy-policy.md?raw'
import termsMd from '../../docs/terms-of-service.md?raw'
import MarkdownArticle from '@/components/MarkdownArticle.vue'
import LogoMark from '@/components/LogoMark.vue'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { useSupportEmail, DEFAULT_SUPPORT_EMAIL } from '@/composables/useSupportEmail'

const props = defineProps({
  doc: { type: String, required: true, validator: (v) => ['privacy', 'terms'].includes(v) },
})

const DOCS = { privacy: privacyMd, terms: termsMd }

const { locale } = useI18n()
const supportEmail = useSupportEmail()

// The documents name the hosted inbox. A deployment that set its own
// SUPPORT_EMAIL should show that one instead, everywhere it appears.
const md = computed(() => {
  const src = DOCS[props.doc] || ''
  const addr = supportEmail.value
  return addr && addr !== DEFAULT_SUPPORT_EMAIL ? src.replaceAll(DEFAULT_SUPPORT_EMAIL, addr) : src
})

// The router has no scrollBehavior, so hopping between the two documents
// from the footer would otherwise land halfway down the new one.
watch(() => props.doc, () => nextTick(() => window.scrollTo(0, 0)))
</script>

<template>
  <div class="legal-wrap">
    <div class="legal-top">
      <RouterLink to="/" class="legal-brand">
        <LogoMark :size="24" />
        <span class="wm brand-wordmark">DIVING<span>HQ</span></span>
      </RouterLink>
      <div class="legal-top-actions">
        <ThemeToggle compact />
        <LocaleSwitcher />
      </div>
    </div>

    <p v-if="locale !== 'en'" class="legal-lang-note">{{ $t('legal.english_only') }}</p>

    <MarkdownArticle :md="md" />

    <footer class="legal-footer">
      <RouterLink to="/privacy" :class="{ 'is-current': doc === 'privacy' }">{{ $t('legal.privacy_title') }}</RouterLink>
      <RouterLink to="/terms" :class="{ 'is-current': doc === 'terms' }">{{ $t('legal.terms_title') }}</RouterLink>
      <RouterLink to="/guide">{{ $t('guide.title') }}</RouterLink>
      <a v-if="supportEmail" :href="`mailto:${supportEmail}`">{{ $t('legal.contact') }}</a>
    </footer>
  </div>
</template>

<style scoped>
.legal-wrap {
  /* width: 100% because the sign-in and register views leave a flex,
     centred body rule behind (their :global(body) styles stay loaded
     after you navigate away), which would shrink-wrap this column. */
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 3rem;
}
.legal-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
}
.legal-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
.legal-brand .wm { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; color: var(--fg); }
.legal-brand .wm span { color: var(--accent); }
.legal-top-actions { display: flex; align-items: center; gap: 0.5rem; }
.legal-lang-note {
  margin: 0 0 1.5rem;
  padding: 0.6rem 0.85rem;
  font-size: 13px;
  color: var(--fg-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.legal-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  margin-top: 3rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--border);
}
.legal-footer a {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg-2);
  text-decoration: none;
}
.legal-footer a:hover { color: var(--accent); }
.legal-footer a.is-current { color: var(--fg); font-weight: 600; }
@media (max-width: 560px) {
  .legal-wrap { padding: 1rem 1rem 2.5rem; }
}
</style>
