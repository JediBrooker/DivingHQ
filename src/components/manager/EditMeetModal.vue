<script setup>
/* EditMeetModal handles the meet's core fields (name, dates,
 * venue, description) plus sponsor branding, including the
 * multi-logo manager (migration 045). Extracted from
 * ManagerView.vue, opened from the per-meet Edit button.
 *
 * Mount contract: the parent fetches the FULL meet row first
 * (the org meets list lacks description + sponsor fields) and
 * only mounts this with v-if once that succeeds, so the form
 * never renders half-hydrated. Same as the old openEditMeet().
 * The body scroll lock stays in the parent, keyed off the same
 * open condition.
 *
 * State boundary: the editable form copy, saving, and error are
 * OWNED here (initialForm prop is cloned, never mutated). A
 * successful PUT emits `saved`, the parent reloads its meets
 * list, then `close`.
 */
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { showSuccess } from '@/composables/useNotify'
import SponsorLogosManager from '@/components/manager/SponsorLogosManager.vue'
import MeetFeesEditor from '@/components/manager/MeetFeesEditor.vue'
import MeetAccessEditor from '@/components/manager/MeetAccessEditor.vue'
import MeetBundleEditor from '@/components/manager/MeetBundleEditor.vue'

const props = defineProps({
  meetId:      { type: String, required: true },
  // Hydrated form snapshot from the parent's /api/meets/:id fetch:
  // { name, venue, start_date, end_date, description,
  //   sponsor_name, sponsor_link_url }
  initialForm: { type: Object, required: true },
})
const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()

const editMeetForm = ref({ ...props.initialForm })
const editMeetErr = ref('')
const editMeetSaving = ref(false)

async function saveMeet() {
  editMeetErr.value = ''
  if (!editMeetForm.value.name.trim()) {
    editMeetErr.value = 'Meet name is required'
    return
  }
  editMeetSaving.value = true
  try {
    await auth.apiFetch(`/api/meets/${props.meetId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name:             editMeetForm.value.name.trim(),
        venue:            editMeetForm.value.venue.trim() || null,
        start_date:       editMeetForm.value.start_date || null,
        end_date:         editMeetForm.value.end_date   || null,
        description:      editMeetForm.value.description.trim() || null,
        sponsor_name:     editMeetForm.value.sponsor_name.trim() || null,
        // The legacy `sponsor_logo_url` field is left untouched since
        // the new sponsor-logos table is the source of truth now.
        // We keep `sponsor_link_url` on the meet row for the
        // pre-045 fallback path.
        sponsor_link_url: editMeetForm.value.sponsor_link_url.trim() || null,
      }),
    })
    showSuccess('Meet updated')
    emit('saved')
    emit('close')
  } catch (err) {
    editMeetErr.value = err.message
  } finally {
    editMeetSaving.value = false
  }
}
</script>

<template>
  <div class="mgr-form-page">
    <div class="mgr-form-card modal-edit-meet" style="max-width:680px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2 style="font-size:20px">{{ $t('manager.modals.edit_meet_title') }}</h2>
        <button class="btn btn-ghost btn-sm" @click="$emit('close')">{{ $t('manager.modals.cancel_x') }}</button>
      </div>
      <form @submit.prevent="saveMeet" class="form-stack">
        <div class="field">
          <label class="label">Meet Name</label>
          <input class="input" v-model="editMeetForm.name" required>
        </div>
        <div class="field">
          <label class="label">Venue (optional)</label>
          <input class="input" v-model="editMeetForm.venue">
        </div>
        <div class="field" style="display:flex;gap:0.5rem">
          <div style="flex:1; min-width:0">
            <label class="label">Start Date</label>
            <input class="input" type="date" v-model="editMeetForm.start_date">
          </div>
          <div style="flex:1; min-width:0">
            <label class="label">End Date</label>
            <input class="input" type="date" v-model="editMeetForm.end_date">
          </div>
        </div>
        <div class="field">
          <label class="label">Description (optional)</label>
          <textarea class="input" rows="2" v-model="editMeetForm.description"
                    placeholder="Public meet blurb — shown on the meet landing page."></textarea>
        </div>

        <hr style="border:0;border-top:1px solid var(--border);margin:0.5rem 0 0">

        <div class="field">
          <label class="label">Sponsor name (optional)</label>
          <input class="input" v-model="editMeetForm.sponsor_name"
                 placeholder='e.g. "Powered by Speedo"'>
          <p class="hint">Plain text shown on the public meet page when no logo is uploaded.</p>
        </div>
        <div class="field">
          <label class="label">Sponsor link (optional)</label>
          <input class="input" type="url" v-model="editMeetForm.sponsor_link_url"
                 placeholder="https://…">
          <p class="hint">Where the "Powered by" name links to. Per-logo links override this on the new uploads.</p>
        </div>

        <!-- The multi-logo manager loads its own data from the
             sponsor-logos endpoints. -->
        <div class="field" style="margin-top:0.25rem">
          <SponsorLogosManager :meet-id="meetId" />
        </div>

        <div class="field" style="margin-top:0.25rem">
          <label class="label">Registration fees</label>
          <MeetFeesEditor :meet-id="meetId" />
        </div>

        <div class="field" style="margin-top:0.25rem">
          <label class="label">Tickets, livestream &amp; programme</label>
          <MeetAccessEditor :meet-id="meetId" />
        </div>

        <div class="field" style="margin-top:0.25rem">
          <label class="label">Discounted bundle</label>
          <MeetBundleEditor :meet-id="meetId" />
        </div>

        <div v-if="editMeetErr" class="msg msg-error">{{ editMeetErr }}</div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button type="button" class="btn btn-ghost" @click="$emit('close')">{{ $t('manager.modals.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="editMeetSaving">
            {{ editMeetSaving ? $t('manager.modals.saving') : $t('manager.modals.edit_meet_submit') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
/* Form-page frame + hint styles COPIED from ManagerView.css,
   shared with the create-event / edit-event / create-meet form
   pages that stay in the view (keep in sync). Create/edit forms
   render as full-page panels in the content area rather than
   floating modal popups. */
.mgr-form-page { padding: 0 0 2rem; }
.mgr-form-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 1.5rem 1.75rem 2rem;
  width: 100%;
  margin: 0 auto;
}
.form-stack{display:flex;flex-direction:column;gap:1rem;}
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem; margin-top: 0.4rem;
  background: var(--bg-3); border-inline-start: 3px solid var(--cyan); border-radius: 3px;
}
</style>
