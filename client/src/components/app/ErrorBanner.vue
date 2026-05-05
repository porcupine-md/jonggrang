<script setup>
defineProps({
  message: {
    type: String,
    required: true,
  },
});

defineEmits(['dismiss']);
</script>

<template>
  <div class="error-banner" role="alert">
    <span>{{ message }}</span>
    <button class="error-banner-dismiss" @click="$emit('dismiss')">Dismiss</button>
  </div>
</template>

<style scoped>
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--red-muted);
  border-bottom: 1px solid rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  font-size: 12px;
}

.error-banner-dismiss {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
}

.error-banner-dismiss:hover {
  text-decoration: underline;
}
</style>
