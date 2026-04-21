<script setup>
import { XIcon } from 'lucide-vue-next';

defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    required: true,
  },
});

defineEmits(['close']);
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="overlay" @click.self="$emit('close')">
      <div class="modal">
        <div class="modal-head">
          <span class="modal-title">{{ title }}</span>
          <slot name="header-extra" />
          <button class="icon-btn" @click="$emit('close')">
            <XIcon :size="15" />
          </button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal {
  background: var(--bg-modal);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  width: 440px;
  max-width: 90vw;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
  font-weight: 600;
  font-size: 14px;
}

.modal-title {
  flex: 1;
}

.modal-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle);
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

:deep(.modal-btn-primary),
:deep(.modal-btn-ghost) {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.15s;
}

:deep(.modal-btn-primary) {
  background: var(--green);
  color: #000;
}

:deep(.modal-btn-primary:hover) {
  background: #0ea271;
}

:deep(.modal-btn-primary:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}

:deep(.modal-btn-ghost) {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

:deep(.modal-btn-ghost:hover) {
  background: var(--bg-modal);
}

:deep(.modal-textarea) {
  width: 100%;
  resize: vertical;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  padding: 10px 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}

:deep(.modal-textarea:focus) {
  border-color: var(--accent);
}

:deep(.modal-hint) {
  font-size: 11px;
  color: var(--text-muted);
}

:deep(.modal-field) {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

:deep(.modal-field label) {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

:deep(.modal-field input),
:deep(.modal-field textarea) {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  padding: 8px 10px;
  font-family: inherit;
  outline: none;
  width: 100%;
  resize: vertical;
}

:deep(.modal-field input:focus),
:deep(.modal-field textarea:focus) {
  border-color: var(--accent);
}
</style>
