<script setup>
import { FileTextIcon, CheckCircle2Icon } from 'lucide-vue-next';
import BaseModal from './BaseModal.vue';

defineProps({
  show: { type: Boolean, default: false },
  description: { type: String, required: true },
  stage: { type: String, default: 'describe' },
  pendingPlan: { type: String, default: '' },
  isRunning: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'update:description', 'update:pendingPlan', 'run', 'approve', 'discard', 'back']);

function updateDescription(event) {
  emit('update:description', event.target.value);
}

function updatePendingPlan(event) {
  emit('update:pendingPlan', event.target.value);
}
</script>

<template>
  <!-- Stage 1: Describe -->
  <BaseModal
    v-if="stage === 'describe'"
    :show="show"
    title="Plan Feature"
    @close="$emit('close')"
  >
    <template #header-extra>
      <span class="stage-badge">1 / 2 — Describe</span>
    </template>
    <textarea
      :value="description"
      class="modal-textarea"
      rows="3"
      placeholder="Describe the feature to plan... (Ctrl+Enter to generate)"
      autofocus
      @input="updateDescription"
      @keydown.ctrl.enter="$emit('run')"
    ></textarea>
    <template #footer>
      <button class="modal-btn-ghost" @click="$emit('close')">Cancel</button>
      <button class="modal-btn-primary" @click="$emit('run')" :disabled="!description.trim() || isRunning">
        <FileTextIcon :size="13" /> Generate Plan
      </button>
    </template>
  </BaseModal>

  <!-- Stage 2: Review & Approve -->
  <BaseModal
    v-else-if="stage === 'review'"
    :show="show"
    title="Review Plan"
    :wide="true"
    @close="$emit('close')"
  >
    <template #header-extra>
      <span class="stage-badge">2 / 2 — Review &amp; Approve</span>
    </template>
    <p class="modal-hint plan-review-hint">Edit the plan below, then approve to decompose into tasks.</p>
    <textarea
      :value="pendingPlan"
      class="modal-textarea plan-textarea"
      spellcheck="false"
      @input="updatePendingPlan"
    ></textarea>
    <template #footer>
      <button class="modal-btn-ghost modal-btn-danger" @click="$emit('discard')">Discard</button>
      <button class="modal-btn-ghost" @click="$emit('back')">← Back</button>
      <button class="modal-btn-primary" @click="$emit('approve')">
        <CheckCircle2Icon :size="13" /> Approve &amp; Decompose
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.stage-badge {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border-radius: 4px;
  padding: 2px 6px;
  letter-spacing: 0.03em;
}

.plan-review-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.plan-textarea {
  min-height: 380px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}

:deep(.modal-btn-danger) {
  background: var(--red-muted);
  color: var(--red);
}

:deep(.modal-btn-danger:hover) {
  background: rgba(239, 68, 68, 0.2);
}
</style>
