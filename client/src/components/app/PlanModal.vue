<script setup>
import { FileTextIcon } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';

defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  description: {
    type: String,
    required: true,
  },
});

const emit = defineEmits(['close', 'update:description', 'run']);

function updateDescription(event) {
  emit('update:description', event.target.value);
}
</script>

<template>
  <BaseModal :show="show" title="Plan Feature" @close="$emit('close')">
    <textarea
      :value="description"
      class="modal-textarea"
      rows="3"
      placeholder="Describe the feature to plan..."
      autofocus
      @input="updateDescription"
      @keydown.ctrl.enter="$emit('run')"
    ></textarea>

    <template #footer>
      <button class="modal-btn-ghost" @click="$emit('close')">Cancel</button>
      <button class="modal-btn-primary" @click="$emit('run')" :disabled="!description.trim()">
        <FileTextIcon :size="13" /> Plan
      </button>
    </template>
  </BaseModal>
</template>
