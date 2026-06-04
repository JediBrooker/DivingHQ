<script setup>
// Tiny header-friendly language picker. Renders as a flag-prefixed
// dropdown; defaults to compact mode (just the flag) on narrow
// screens via a CSS media query, full mode (flag + label) on wider.
//
// Slot the component into any header. Persists the choice via
// setLocale() in src/i18n/index.js (localStorage + <html lang>).

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, setLocale } from '@/i18n'

const { locale } = useI18n()

const current = computed(() =>
  SUPPORTED_LOCALES.find(l => l.code === locale.value) || SUPPORTED_LOCALES[0])

async function onChange(e) {
  await setLocale(e.target.value)
}
</script>

<template>
  <label class="locale-switcher" v-tip:bottom="$t('locale.switcher_label')">
    <!-- Standalone flag shows the CURRENT selection. The native
         <select>'s rendered text is just the language name — if
         we also embed the flag inside <option>, the selected
         option's text would render the flag a second time next
         to the standalone span (the "two flags" bug). -->
    <span class="locale-flag" aria-hidden="true">{{ current.flag }}</span>
    <select :value="locale" @change="onChange" class="locale-select">
      <option v-for="l in SUPPORTED_LOCALES" :key="l.code" :value="l.code">
        {{ l.label }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.locale-switcher {
  position: relative;
  display: inline-flex; align-items: center; gap: 0.35rem;
  padding: 0.35rem 0.5rem;
  background: var(--bg-2); border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.locale-switcher:hover { border-color: var(--cyan); }
.locale-flag { font-size: 14px; line-height: 1; }
.locale-select {
  appearance: none; -webkit-appearance: none;
  border: none; outline: none; background: transparent;
  color: var(--text-2); font-family: var(--font-mono); font-size: 11px;
  padding-block: 0;
  padding-inline: 0 1.2rem;
  cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--text-3) 50%),
                    linear-gradient(135deg, var(--text-3) 50%, transparent 50%);
  /* Anchor the custom dropdown arrow to the inline-end edge so it
     flips correctly under <html dir="rtl">. */
  background-position: right 9px center, right 5px center;
  background-size: 4px 4px;
  background-repeat: no-repeat;
}
:root[dir="rtl"] .locale-select {
  background-position: left 9px center, left 5px center;
}
.locale-select option { background: var(--bg-1); color: var(--text); }
</style>
