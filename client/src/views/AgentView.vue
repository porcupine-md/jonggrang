<template>
  <div class="agent-view">
    <div class="agent-toolbar">
      <div class="toolbar-left">
        <i class="pi pi-microchip-ai toolbar-icon" />
        <span v-if="featureId" class="scope-chip" :title="`Worktree: ${featureId}`">
          <i class="pi pi-code-branch" /> {{ featureId }}
        </span>
        <Select
          v-model="selectedTool"
          :options="toolOptions"
          optionLabel="label"
          optionValue="value"
          :disabled="isRunning"
          class="tool-select"
        />
        <span v-if="isRunning" class="status-chip status-chip--running">
          <span class="running-dot" /> Running
        </span>
        <span v-else class="status-chip status-chip--idle">Stopped</span>
      </div>
      <div class="toolbar-right">
        <Button
          v-if="!isRunning"
          size="small"
          :disabled="starting"
          @click="startAgent"
        >
          <i class="pi pi-play" /> {{ starting ? 'Starting...' : 'Start' }}
        </Button>
        <Button
          v-else
          size="small"
          severity="danger"
          @click="stopAgent"
        >
          <i class="pi pi-stop" /> Stop
        </Button>
      </div>
    </div>
    <div ref="terminalRef" class="agent-terminal" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useWsStore } from '../stores/ws.js';
import { useInteractiveTerminal } from '../composables/useInteractiveTerminal.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
// Work Mode: agent runs inside this plan's worktree.
const featureId = computed(() => route.params.featureId || null);
const session = computed(() => featureId.value ? `agent:${featureId.value}` : 'agent');
const ws = useWsStore();

const selectedTool = ref('jonggrang');
const starting = ref(false);

const toolOptions = [
  { label: 'Jonggrang (Pi)', value: 'jonggrang' },
  { label: 'Claude Code',    value: 'claude' },
  { label: 'OpenCode',       value: 'opencode' },
];

const { terminalRef, isRunning, markRunning, markStopped, fit } =
  useInteractiveTerminal({
    projectId: computed(() => projectId.value),
    session: session.value,
    getSocket: () => ws.socket,
  });

onMounted(async () => {
  try {
    const qs = featureId.value ? `?feature_id=${encodeURIComponent(featureId.value)}` : '';
    const res = await fetch(`/api/projects/${projectId.value}/agent/config${qs}`);
    const data = await res.json();
    if (data.tool) selectedTool.value = data.tool;
    if (data.running) markRunning();
  } catch {}
});

async function startAgent() {
  starting.value = true;
  try {
    const el = terminalRef.value;
    const cols = el ? Math.floor(el.clientWidth / 7.5) : 80;
    const rows = el ? Math.floor(el.clientHeight / 17) : 24;
    const body = { tool: selectedTool.value, cols, rows };
    if (featureId.value) body.feature_id = featureId.value;
    await fetch(`/api/projects/${projectId.value}/agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    markRunning();
  } catch {}
  starting.value = false;
}

async function stopAgent() {
  await fetch(`/api/projects/${projectId.value}/agent/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(featureId.value ? { feature_id: featureId.value } : {}),
  });
  markStopped();
}

onBeforeRouteLeave((to, from, next) => {
  if (!isRunning.value) return next();
  const ok = window.confirm('Agent is still running. Leaving will kill the process. Continue?');
  if (ok) {
    stopAgent();
    next();
  } else {
    next(false);
  }
});
</script>

<style scoped>
.agent-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.agent-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--jg-border);
  background: var(--jg-card); flex-shrink: 0; gap: 12px;
}
.toolbar-left { display: flex; align-items: center; gap: 10px; }
.toolbar-right { display: flex; align-items: center; gap: 8px; }
.toolbar-icon { font-size: 14px; color: var(--jg-green); }
.scope-chip {
  display: flex; align-items: center; gap: 4px;
  font-size: 10px; font-family: monospace; color: var(--jg-text-muted);
  border: 1px solid var(--jg-border); padding: 2px 7px;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.tool-select { width: 160px; }
.tool-select :deep(.p-select) { height: 30px; font-size: 12px; }

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

.agent-terminal {
  flex: 1; overflow: hidden;
  background: #0f1520; padding: 4px 8px 0;
}
.agent-terminal :deep(.xterm) { height: 100%; }
.agent-terminal :deep(.xterm-viewport) { overflow-y: hidden !important; }
</style>
