<template>
  <div class="plan-discuss">
    <div class="discuss-header">
      <span class="discuss-title"><i class="pi pi-comments" /> Discuss</span>
      <span class="discuss-tool">{{ toolLabel }}</span>
      <span v-if="isRunning" class="discuss-status discuss-status--live"><span class="dot" /> live</span>
      <span v-else class="discuss-status">stopped</span>
      <div style="flex:1" />
      <button class="discuss-btn" :disabled="starting" title="Restart discussion" @click="restart">
        <i class="pi pi-refresh" />
      </button>
      <button class="discuss-btn" title="Close" @click="$emit('close')">
        <i class="pi pi-times" />
      </button>
    </div>
    <div ref="terminalRef" class="discuss-terminal" />
    <div v-if="error" class="discuss-error">{{ error }}</div>
    <div class="discuss-hint">Read-only — the agent won't edit files. Use "Revise with AI" to apply changes to the plan.</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useWsStore } from '../../stores/ws.js';
import { useInteractiveTerminal } from '../../composables/useInteractiveTerminal.js';

const props = defineProps({
  projectId: { type: [String, Object], required: true },
  sessionId: { type: String, default: '' },
  tool:      { type: String, default: '' },
});
defineEmits(['close']);

const ws = useWsStore();
const starting = ref(false);
const error = ref('');

const TOOL_LABELS = {
  jonggrang: 'Jonggrang (Pi)',
  claude:    'Claude Code',
  opencode:  'OpenCode',
  codex:     'OpenAI Codex',
};
const toolLabel = computed(() => TOOL_LABELS[props.tool] || props.tool || 'agent');
const pid = computed(() => (typeof props.projectId === 'object' ? props.projectId.value : props.projectId));

const { terminalRef, isRunning, markRunning, markStopped } = useInteractiveTerminal({
  projectId: pid,
  session: 'discuss',
  getSocket: () => ws.socket,
});

async function start() {
  starting.value = true;
  error.value = '';
  try {
    const el = terminalRef.value;
    const cols = el ? Math.floor(el.clientWidth / 7.5) : 80;
    const rows = el ? Math.floor(el.clientHeight / 17) : 24;
    const res = await fetch(`/api/projects/${pid.value}/plan/discuss/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: props.tool, sessionId: props.sessionId, cols, rows }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || 'Failed to start discussion');
    markRunning();
  } catch (e) {
    error.value = e.message;
  }
  starting.value = false;
}

async function stop() {
  try {
    await fetch(`/api/projects/${pid.value}/plan/discuss/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {}
  markStopped();
}

async function restart() {
  await stop();
  await start();
}

onMounted(start);
onBeforeUnmount(stop);
</script>

<style scoped>
.plan-discuss {
  width: 440px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden;
  border-left: 1px solid var(--jg-border);
}
.discuss-header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--jg-border); flex-shrink: 0; background: var(--jg-card);
}
.discuss-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--jg-text-faint); display: flex; align-items: center; gap: 6px;
}
.discuss-tool { font-size: 10px; font-family: var(--font-mono); color: var(--jg-green); }
.discuss-status { font-size: 10px; color: var(--jg-text-faint); display: flex; align-items: center; gap: 5px; }
.discuss-status--live { color: var(--jg-green); }
.discuss-status--live .dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--jg-green); animation: discussPulse 1s infinite;
}
@keyframes discussPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.discuss-btn {
  width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  background: none; border: 1px solid var(--jg-border); color: var(--jg-text-faint); cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}
.discuss-btn:hover:not(:disabled) { color: var(--jg-text); border-color: var(--jg-text-muted); }
.discuss-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.discuss-btn .pi { font-size: 11px; }
.discuss-terminal { flex: 1; overflow: hidden; background: #0f1520; padding: 4px 8px 0; }
.discuss-terminal :deep(.xterm) { height: 100%; }
.discuss-terminal :deep(.xterm-viewport) { overflow-y: auto !important; }
.discuss-error { font-size: 11px; color: var(--jg-red); padding: 6px 12px; flex-shrink: 0; }
.discuss-hint {
  font-size: 10px; color: var(--jg-text-faint); padding: 6px 12px; flex-shrink: 0;
  border-top: 1px solid var(--jg-border); line-height: 1.4;
}
</style>
