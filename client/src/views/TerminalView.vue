<template>
  <div class="terminal-view">
    <div class="terminal-toolbar">
      <div class="toolbar-left">
        <i class="pi pi-dollar toolbar-icon" />
        <span class="toolbar-label">Shell</span>
        <span v-if="isRunning" class="status-chip status-chip--running">
          <span class="running-dot" /> Running
        </span>
        <span v-else class="status-chip status-chip--idle">Stopped</span>
      </div>
      <div class="toolbar-right">
        <Button v-if="!isRunning" size="small" :disabled="starting" @click="startTerminal">
          <i class="pi pi-play" /> {{ starting ? 'Starting...' : 'Start' }}
        </Button>
        <Button v-else size="small" severity="danger" @click="stopTerminal">
          <i class="pi pi-stop" /> Stop
        </Button>
      </div>
    </div>
    <div ref="terminalRef" class="shell-terminal" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import Button from 'primevue/button';
import { useWsStore } from '../stores/ws.js';
import { useInteractiveTerminal } from '../composables/useInteractiveTerminal.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const ws = useWsStore();
const starting = ref(false);

const { terminalRef, isRunning, markRunning, markStopped, fit } =
  useInteractiveTerminal({
    projectId: computed(() => projectId.value),
    session: 'terminal',
    getSocket: () => ws.socket,
  });

onMounted(() => startTerminal());

async function startTerminal() {
  starting.value = true;
  try {
    const el = terminalRef.value;
    const cols = el ? Math.floor(el.clientWidth / 7.5) : 80;
    const rows = el ? Math.floor(el.clientHeight / 17) : 24;
    await fetch(`/api/projects/${projectId.value}/terminal/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    });
    markRunning();
  } catch {}
  starting.value = false;
}

async function stopTerminal() {
  await fetch(`/api/projects/${projectId.value}/terminal/stop`, { method: 'POST' });
  markStopped();
}

onBeforeRouteLeave((to, from, next) => {
  if (!isRunning.value) return next();
  const ok = window.confirm('Terminal is still running. Leaving will kill the process. Continue?');
  if (ok) {
    stopTerminal();
    next();
  } else {
    next(false);
  }
});
</script>

<style scoped>
.terminal-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.terminal-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--jg-border);
  background: var(--jg-card); flex-shrink: 0; gap: 12px;
}
.toolbar-left { display: flex; align-items: center; gap: 10px; }
.toolbar-right { display: flex; gap: 8px; }
.toolbar-icon { font-size: 14px; color: var(--jg-text-faint); }
.toolbar-label { font-size: 12px; font-weight: 600; color: var(--jg-text-muted); }

.status-chip {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; padding: 2px 8px; border-radius: 0;
}
.status-chip--running { color: var(--jg-green); }
.status-chip--idle { color: var(--jg-text-faint); }
.running-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--jg-green); animation: pulse 1s infinite;
}
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

.shell-terminal {
  flex: 1; overflow: hidden;
  background: #0f1520; padding: 4px 8px 0;
}
.shell-terminal :deep(.xterm) { height: 100%; }
.shell-terminal :deep(.xterm-viewport) { overflow-y: hidden !important; }
</style>
