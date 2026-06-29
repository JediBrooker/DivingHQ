<script setup>
// Drop-in entry-fee editor for an event's manager page. Mount it on the
// event-management view, e.g.:
//   <EntryFeeEditor :event-id="event.id" />
import FeeEditor from '@/components/payments/FeeEditor.vue'

defineProps({ eventId: { type: String, required: true } })
</script>

<template>
  <section class="entry-fee">
    <h3>Entry fee</h3>
    <FeeEditor
      title="Entry fee"
      :load-url="`/api/events/${eventId}/fee/config`"
      :save-url="`/api/events/${eventId}/fee`"
    />
  </section>
</template>

<style scoped>
.entry-fee { display: flex; flex-direction: column; gap: .5rem; }
</style>
