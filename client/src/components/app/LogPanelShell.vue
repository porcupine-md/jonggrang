<script setup>
defineProps({
  isRunning: {
    type: Boolean,
    default: false,
  },
  hasLogs: {
    type: Boolean,
    default: false,
  },
  logLineCount: {
    type: Number,
    default: 0,
  },
});

defineEmits(['copy-logs', 'clear-logs']);
</script>

<template>
  <div class="logs-section">
    <div class="logs-header">
      <div class="logs-header-left">
        <div class="log-dot" :class="{ active: isRunning }"></div>
        <span>LOGS</span>
        <span v-if="hasLogs" class="log-linecount">{{ logLineCount }} lines</span>
      </div>
      <div class="logs-header-actions">
        <button class="log-action-btn" title="Copy logs" @click="$emit('copy-logs')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="log-action-btn" title="Clear logs" @click="$emit('clear-logs')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </div>
    <div class="terminal-wrap">
      <slot />
    </div>
    <div v-if="!hasLogs" class="log-empty">WAITING FOR OUTPUT...</div>
  </div>
</template>

<style scoped>
.logs-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px 5px 10px;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  text-transform: uppercase;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.logs-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.logs-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.log-linecount {
  font-size: 9px;
  color: rgba(255, 255, 255, 0.2);
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}

.log-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.log-action-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.log-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}

.log-dot.active {
  background: var(--green);
  animation: blink 1s infinite;
}

.terminal-wrap {
  flex: 1;
  overflow: hidden;
  padding: 6px 4px 4px;
  position: relative;
  min-height: 0;
  background: #0a0b0f;
}

:deep(.terminal-host) {
  height: 100%;
}

:deep(.xterm) {
  height: 100%;
}

:deep(.xterm-screen) {
  height: 100% !important;
}

:deep(.xterm-viewport) {
  border-radius: 4px;
}

:deep(.xterm-viewport::-webkit-scrollbar) {
  width: 5px;
}

:deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

:deep(.xterm-viewport::-webkit-scrollbar-track) {
  background: transparent;
}

.log-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
}

@keyframes blink {
  0%,
  100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
