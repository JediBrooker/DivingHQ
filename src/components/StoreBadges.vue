<script setup>
// "Get the app" buttons for the public pages (home, sign-in). They're our
// own buttons rather than Apple's and Google's badge artwork, so they follow
// the theme. Never shown inside the native app itself.
import { Smartphone } from '@lucide/vue'
import { isNativeApp } from '@/lib/native-platform'
import { storesFor } from '@/lib/storeLinks'

const stores = isNativeApp()
  ? []
  : storesFor({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints })

const STORE_NAME = { play: 'Google Play', apple: 'App Store' }
const LABEL_KEY = { play: 'common.app_android', apple: 'common.app_iphone' }
</script>

<template>
  <div v-if="stores.length" class="store-badges" data-testid="store-badges">
    <span class="store-lead">{{ $t('common.get_app') }}</span>
    <a
      v-for="s in stores"
      :key="s.store"
      :href="s.url"
      target="_blank"
      rel="noopener"
      class="store-badge"
      :data-store="s.store"
      :aria-label="`${$t(LABEL_KEY[s.store])}, ${STORE_NAME[s.store]}`"
    >
      <Smartphone aria-hidden="true" />
      <span class="store-text">
        <span class="store-name">{{ STORE_NAME[s.store] }}</span>
        <span class="store-what">{{ $t(LABEL_KEY[s.store]) }}</span>
      </span>
    </a>
  </div>
</template>

<style scoped>
.store-badges {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
  gap: 0.6rem;
}
.store-lead { font-size: 13px; color: var(--fg-2); }
.store-badge {
  display: inline-flex; align-items: center; gap: 0.55rem;
  padding: 0.4rem 0.9rem 0.4rem 0.7rem;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--fg);
  text-decoration: none; text-align: start;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.store-badge:hover { background: var(--surface-hover); border-color: var(--accent); }
.store-badge :deep(svg) { width: 20px; height: 20px; color: var(--accent); flex: none; }
.store-text { display: flex; flex-direction: column; line-height: 1.2; }
.store-name { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-3); }
.store-what { font-size: 13.5px; font-weight: 600; }
</style>
