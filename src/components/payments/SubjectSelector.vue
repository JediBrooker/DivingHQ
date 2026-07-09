<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])

const auth = useAuthStore()
const { t } = useI18n()
const dependents = ref([])

function age(dob) {
  const birth = new Date(dob)
  const today = new Date()
  let y = today.getFullYear() - birth.getFullYear()
  const m = today.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) y--
  return y
}

onMounted(async () => {
  try {
    const res = await auth.apiFetch('/api/guardians/my-dependents')
    dependents.value = Array.isArray(res) ? res : []
  } catch { /* no dependents */ }
})
</script>

<template>
  <div v-if="dependents.length" class="subject-selector">
    <label>
      {{ t('guardians.paying_for') }}
      <select
        :value="modelValue"
        @change="emit('update:modelValue', $event.target.value)"
      >
        <option value="">{{ t('guardians.paying_for_self') }}</option>
        <option
          v-for="dep in dependents"
          :key="dep.id"
          :value="dep.id"
        >
          {{ dep.full_name }} ({{ age(dep.date_of_birth) }})
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.subject-selector { margin-bottom: 0.75rem; }
.subject-selector select { padding: 0.3rem; }
</style>
