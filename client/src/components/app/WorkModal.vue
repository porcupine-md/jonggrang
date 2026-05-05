<script setup>
import { PlayIcon } from 'lucide-vue-next';
import { getWorkTypeStyle } from '../../utils/appUi';
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
  workType: {
    type: String,
    default: null,
  },
  workTypeHint: {
    type: String,
    default: '',
  },
});

const emit = defineEmits(['close', 'update:description', 'run']);

function updateDescription(event) {
  emit('update:description', event.target.value);
}
</script>

<template>
  <BaseModal :show="show" title="Run Work" @close="$emit('close')">
    <template #header-extra>
      <span v-if="workType" class="wt-badge" :style="getWorkTypeStyle(workType)">
        {{ workType }}
      </span>
    </template>

    <textarea
      :value="description"
      class="modal-textarea"
      rows="3"
      placeholder="Describe the feature... (e.g. add /ping endpoint)"
      autofocus
      @input="updateDescription"
      @keydown.ctrl.enter="$emit('run')"
    ></textarea>
    <div v-if="workTypeHint" class="modal-hint">{{ workTypeHint }}</div>

    <template #footer>
      <button class="modal-btn-ghost" @click="$emit('close')">Cancel</button>
      <button class="modal-btn-primary" @click="$emit('run')" :disabled="!description.trim()">
        <PlayIcon :size="13" /> Run
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.wt-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
</style>
