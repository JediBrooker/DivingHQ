<script setup>
/* SponsorRotation: display-side companion to the
 * SponsorLogosManager in Phase 2. Self-fetches the meet's
 * sponsor logos and cycles through them on the rotation
 * cadence the operator set.
 *
 * Used in three placements (set via the `placement` prop):
 *
 *   'corner': fixed-position bottom-right tile during live
 *              broadcast mode. ~80px tall, semi-translucent
 *              background. Doesn't compete with the active
 *              diver block.
 *   'overlay': same vibe as 'corner' but transparent so it
 *              chroma-keys cleanly when fed into OBS via the
 *              ?overlay=1 stream view.
 *   'inline': non-rotating row of all logos for the public
 *              meet landing page hero strip. Rendered as a
 *              static "Powered by" panel.
 *
 * Rotation behaviour:
 *   • 0 seconds → no rotation. In corner/overlay mode, only
 *     slot 1 renders.
 *   • >0 → cycle every N seconds with a 200ms cross-fade.
 *   • Single-logo meets never rotate regardless of cadence.
 *   • Pauses when document.visibilityState is 'hidden' so
 *     the cycle doesn't drift while the operator is on a
 *     different tab, picks back up on the next visible event.
 *
 * Legacy fallback: API returns a single `legacy: true` row
 * when the meet has only the pre-045 single-URL sponsor field.
 * That renders identically to a slot-1 logo, no separate code
 * path needed.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { reduceMotion } from '@/composables/useReducedMotion'

const props = defineProps({
  // ID of the meet whose logos to fetch. null/undefined = no
  // render (e.g. an event that isn't part of a meet bundle).
  meetId: { type: [String, null], default: null },
  // Layout flavour, see file header.
  placement: {
    type: String,
    default: 'corner',
    validator: (v) => ['corner', 'overlay', 'inline'].includes(v),
  },
})

const logos = ref([])
const rotationSeconds = ref(8)
const currentIdx = ref(0)
const fading = ref(false)

let cycleTimer = null
let visibilityHandler = null

const visibleLogo = computed(() => logos.value[currentIdx.value] || null)

async function load() {
  if (!props.meetId) {
    logos.value = []
    return
  }
  try {
    const r = await fetch(`/api/meets/${props.meetId}/sponsor-logos`)
    if (!r.ok) {
      logos.value = []
      return
    }
    const body = await r.json()
    logos.value = Array.isArray(body.logos)
      ? body.logos.filter((l) => l.image_url) // drop legacy rows without URL
      : []
    rotationSeconds.value = Number.isFinite(body.rotation_seconds)
      ? body.rotation_seconds
      : 8
    currentIdx.value = 0
    startCycle()
  } catch {
    logos.value = []
  }
}

// =============================================================
// Rotation timer. Restarts on meetId change + on visibility
// resume + when the data lands. Stops cleanly on unmount.
// =============================================================
function clearCycle() {
  if (cycleTimer) {
    clearInterval(cycleTimer)
    cycleTimer = null
  }
}
function startCycle() {
  clearCycle()
  // No rotation when:
  //   • cadence is 0 (operator explicitly disabled)
  //   • only one logo (nothing to rotate through)
  //   • inline placement (the public hero strip shows all
  //     logos side by side instead)
  if (rotationSeconds.value <= 0) return
  if (logos.value.length <= 1) return
  if (props.placement === 'inline') return
  cycleTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }
    if (reduceMotion()) {
      // Reduced motion: advance instantly, no 200ms cross-fade.
      currentIdx.value = (currentIdx.value + 1) % logos.value.length
      return
    }
    fading.value = true
    setTimeout(() => {
      currentIdx.value = (currentIdx.value + 1) % logos.value.length
      fading.value = false
    }, 200)
  }, rotationSeconds.value * 1000)
}

onMounted(() => {
  load()
  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') startCycle()
      else clearCycle()
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }
})
onUnmounted(() => {
  clearCycle()
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler)
  }
})

// Refetch when the meet changes (operator picks a different
// event in the same SPA session).
watch(() => props.meetId, load)
</script>

<template>
  <div v-if="logos.length"
       :class="['sponsor-rot', `sponsor-rot-${placement}`]"
       :aria-label="visibleLogo ? `Sponsor: ${visibleLogo.alt_text || ''}` : 'Sponsors'"
       :data-rotation-seconds="rotationSeconds">
    <!-- Inline placement: render all logos side by side. -->
    <template v-if="placement === 'inline'">
      <component
        v-for="logo in logos"
        :key="logo.id || logo.image_url"
        :is="logo.link_url ? 'a' : 'span'"
        :href="logo.link_url || undefined"
        :target="logo.link_url ? '_blank' : undefined"
        rel="noopener"
        class="sponsor-rot-tile sponsor-rot-tile-inline"
      >
        <img :src="logo.image_url" :alt="logo.alt_text || 'Sponsor'">
      </component>
    </template>

    <!-- Corner / overlay placement: one logo at a time with a
         fade transition between rotations. -->
    <template v-else>
      <component
        v-if="visibleLogo"
        :key="visibleLogo.id || visibleLogo.image_url"
        :is="visibleLogo.link_url ? 'a' : 'div'"
        :href="visibleLogo.link_url || undefined"
        :target="visibleLogo.link_url ? '_blank' : undefined"
        rel="noopener"
        :class="['sponsor-rot-tile', fading ? 'is-fading' : '']"
      >
        <img :src="visibleLogo.image_url" :alt="visibleLogo.alt_text || 'Sponsor'">
      </component>
    </template>
  </div>
</template>

<style scoped>
.sponsor-rot { pointer-events: auto; }

.sponsor-rot-tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  transition: opacity 0.2s ease;
}
.sponsor-rot-tile.is-fading { opacity: 0; }
.sponsor-rot-tile img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}

/* Corner placement: live broadcast / kiosk view. Anchored
   bottom-right of the viewport so it doesn't compete with the
   active-diver block at the centre. Translucent dark backplate
   so the logo reads against any pool-deck colour. */
.sponsor-rot-corner {
  position: fixed;
  inset-inline-end: 1rem;
  bottom: 1rem;
  z-index: 20;
  width: clamp(140px, 16vw, 220px);
  height: clamp(56px, 7vw, 96px);
  padding: 0.4rem 0.6rem;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: var(--radius-sm, 6px);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.sponsor-rot-corner .sponsor-rot-tile {
  width: 100%;
  height: 100%;
}

/* Overlay placement: composite-friendly for OBS chroma key.
   No backplate, no shadow. The host page (`?overlay=1`) sets
   the chroma colour as its background; the logo composites
   cleanly. */
.sponsor-rot-overlay {
  position: fixed;
  inset-inline-end: 1.5rem;
  bottom: 1.5rem;
  z-index: 20;
  width: clamp(160px, 18vw, 260px);
  height: clamp(64px, 8vw, 110px);
}
.sponsor-rot-overlay .sponsor-rot-tile {
  width: 100%;
  height: 100%;
  /* Subtle text-shadow-style backplate via a drop-shadow
     filter, keeps the logo readable on any chroma colour
     without adding a visible solid background that would
     have to be keyed out separately. */
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5));
}

/* Inline placement: public meet landing page "Powered by"
   strip. Row of static logos with a small gap. */
.sponsor-rot-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
}
.sponsor-rot-tile-inline {
  height: 36px;
  max-width: 160px;
}

@media (max-width: 720px) {
  /* Smaller corner tile on phones so it doesn't crowd the
     active-diver block. */
  .sponsor-rot-corner {
    inset-inline-end: 0.5rem;
    bottom: 0.5rem;
    width: clamp(96px, 30vw, 140px);
    height: clamp(40px, 12vw, 64px);
    padding: 0.3rem 0.4rem;
  }
  .sponsor-rot-overlay {
    inset-inline-end: 0.75rem;
    bottom: 0.75rem;
    width: clamp(120px, 35vw, 180px);
    height: clamp(48px, 14vw, 80px);
  }
  .sponsor-rot-tile-inline { height: 28px; max-width: 120px; }
}
</style>
