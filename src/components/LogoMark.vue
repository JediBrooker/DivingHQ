<script setup>
// DivingHQ brand mark: dive-trajectory arc with the diver at
// apex and an entry ripple at the water line. Inlined as an SVG
// component (rather than an <img>) so it needs no asset-import
// plumbing and can be reused across the shell, nav, and footer.
// Brand colours are fixed (white badge + marine arc), matching
// the design asset, so the mark reads consistently in both themes.
defineProps({
  size: { type: [Number, String], default: 28 },
  label: { type: String, default: 'DivingHQ' },
})
</script>

<template>
  <svg
    class="logo-mark"
    :width="size"
    :height="size"
    viewBox="0 0 512 512"
    role="img"
    :aria-label="label"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect width="512" height="512" rx="96" fill="#ffffff" />
    <rect x="1" y="1" width="510" height="510" rx="95" fill="none" stroke="#e2e8f0" stroke-width="2" />
    <path d="M 120 380 Q 256 80 392 380" stroke="#0b6191" stroke-width="22" fill="none" stroke-linecap="round" opacity="0.14" />
    <path d="M 120 380 Q 256 80 392 380" stroke="#0b6191" stroke-width="12" fill="none" stroke-linecap="round" />
    <circle cx="256" cy="138" r="22" fill="#0b6191" />
    <circle cx="251" cy="133" r="6" fill="#ffffff" opacity="0.55" />
    <circle cx="392" cy="380" r="10" fill="#0b6191" />
    <circle cx="392" cy="380" r="22" fill="none" stroke="#0b6191" stroke-width="2" opacity="0.4" />
    <circle cx="392" cy="380" r="34" fill="none" stroke="#0b6191" stroke-width="2" opacity="0.2" />
  </svg>
</template>

<style scoped>
.logo-mark { display: block; flex-shrink: 0; border-radius: 22%; }
</style>
