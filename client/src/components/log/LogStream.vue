<template>
  <div class="log-root">
    <div class="log-toolbar">
      <div class="log-title"><i class="pi pi-desktop" /> Process Logs</div>
      <Button label="Clear" severity="secondary" size="small" @click="onClear" />
    </div>
    <div v-if="!hasLogs" class="log-empty">
      <i class="pi pi-desktop log-empty-icon" />
      <div>No logs yet. Start a plan or work session.</div>
    </div>
    <div ref="logContainerRef" class="log-terminal" :class="{ 'log-terminal--hidden': !hasLogs }" />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import Button from 'primevue/button';
import { useProcessStore } from '../../stores/process.js';
import { useLogTerminal } from '../../composables/useLogTerminal.js';

const proc = useProcessStore();

const logString = computed(() => proc.globalLog.map(e => e.line).join('\n'));

const { logContainerRef, hasLogs, clearTerminal } = useLogTerminal(logString);

function onClear() {
  proc.clearLogs();
  clearTerminal();
}
</script>

<style scoped>
.log-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.log-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--jg-border);
  flex-shrink: 0; gap: 8px;
}
.log-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--jg-text-faint);
  display: flex; align-items: center; gap: 6px;
}

.log-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; flex: 1; color: var(--jg-text-faint); font-size: 12px;
}
.log-empty-icon { font-size: 24px; }

.log-terminal {
  flex: 1; overflow: hidden;
  padding: 8px 12px 0;
}
.log-terminal--hidden { display: none; }

/* xterm overrides for tight fit */
.log-terminal :deep(.xterm) { height: 100%; }
.log-terminal :deep(.xterm-viewport) { overflow-y: auto !important; }
.log-terminal :deep(.xterm-screen) { padding-left: 0; }
</style>
