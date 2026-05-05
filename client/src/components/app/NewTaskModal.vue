<script setup>
import BaseModal from './BaseModal.vue';

defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
});

const emit = defineEmits(['close', 'update:title', 'update:description', 'create']);

function updateTitle(event) {
  emit('update:title', event.target.value);
}

function updateDescription(event) {
  emit('update:description', event.target.value);
}
</script>

<template>
  <BaseModal :show="show" title="New Task" @close="$emit('close')">
    <div class="modal-field">
      <label>Title</label>
      <input :value="title" placeholder="Task title" autofocus @input="updateTitle" @keydown.enter="$emit('create')" />
    </div>
    <div class="modal-field">
      <label>Description</label>
      <textarea :value="description" placeholder="Optional details..." rows="3" @input="updateDescription"></textarea>
    </div>

    <template #footer>
      <button class="modal-btn-ghost" @click="$emit('close')">Cancel</button>
      <button class="modal-btn-primary" @click="$emit('create')" :disabled="!title.trim()">Create Task</button>
    </template>
  </BaseModal>
</template>
