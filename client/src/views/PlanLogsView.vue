<template>
  <div class="log-root">
    <div class="log-toolbar">
      <div class="log-title">
        <i class="pi pi-desktop" /> {{ view === 'session' ? 'Agent Session' : 'Plan Logs' }}
        <span v-if="group" class="log-status" :class="`ls--${group.status}`">{{ group.status }}</span>
        <span v-if="view === 'session' && sessionLive" class="log-hint">live — you can type into this session</span>
      </div>
      <div class="log-views">
        <button class="log-view-btn" :class="{ 'log-view-btn--on': view === 'session' }" @click="view = 'session'">
          <i class="pi pi-code" /> Terminal
        </button>
        <button class="log-view-btn" :class="{ 'log-view-btn--on': view === 'log' }" @click="view = 'log'">
          <i class="pi pi-list" /> Log
        </button>
      </div>
    </div>

    <!-- Live agent session: the real TUI, mirrored from the worker's pty -->
    <div v-show="view === 'session'" class="log-pane">
      <div v-if="!sessionSeen" class="log-empty">
        <i class="pi pi-code log-empty-icon" />
        <div>No agent session yet. Press Run to start this plan.</div>
        <div class="log-empty-hint">The session appears here only when the project runs Claude in interactive mode.</div>
      </div>
      <div ref="terminalRef" class="log-terminal" :class="{ 'log-terminal--hidden': !sessionSeen }" />
    </div>

    <!-- Structured log (session transcript + jonggrang's own lines) -->
    <div v-show="view === 'log'" class="log-pane">
      <div v-if="!hasLogs" class="log-empty">
        <i class="pi pi-desktop log-empty-icon" />
        <div>No logs for this plan yet. Press Run to start its pipeline.</div>
      </div>
      <div ref="logContainerRef" class="log-terminal" :class="{ 'log-terminal--hidden': !hasLogs }" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useOrchestrationStore } from '../stores/orchestration.js';
import { useWsStore } from '../stores/ws.js';
import { useLogTerminal } from '../composables/useLogTerminal.js';
import { useInteractiveTerminal } from '../composables/useInteractiveTerminal.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId);
const orch = useOrchestrationStore();
const ws = useWsStore();

const group = computed(() => orch.groups[featureId.value] || null);
const logString = computed(() => (group.value?.log || []).join('\n'));
const session = computed(() => `work:${featureId.value}`);

// Terminal is the default view; the structured log stays one click away.
const view = ref('session');
const sessionSeen = ref(false);            // any pty bytes for this plan yet?

const { logContainerRef, hasLogs } = useLogTerminal(logString);

const { terminalRef, write, markRunning, markStopped, fit } = useInteractiveTerminal({
  projectId,
  session,                                  // reactive: follows the plan in the route
  getSocket: () => ws.socket,
});

const sessionLive = computed(() => group.value?.status === 'running' && sessionSeen.value);

// Replay the scrollback so a tab opened mid-run does not start blank, then let
// the socket stream take over.
async function loadSession() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/orchestration/groups/${featureId.value}/pty`);
    if (!res.ok) return;
    const { data, running } = await res.json();
    if (data) {
      sessionSeen.value = true;
      write(data);
      fit();
    }
    if (running) markRunning(); else markStopped();
  } catch { /* leave the pane empty */ }
}

watch(() => group.value?.status, (status) => {
  if (status === 'running') { markRunning(); view.value = 'session'; }
  else markStopped();
});

onMounted(async () => {
  if (!group.value?.log?.length) {
    try {
      const res = await fetch(`/api/projects/${projectId.value}/orchestration`);
      if (res.ok) {
        const view_ = await res.json();
        if (view_ && Array.isArray(view_.groups) && view_.groups.length) orch.hydrate(view_);
      }
    } catch {}
  }
  await loadSession();
});

// Any live byte for this plan means there is a session worth showing.
watch(() => ws.socket, (socket) => {
  if (!socket) return;
  socket.on('pty.data', ({ session: s }) => { if (s === session.value) sessionSeen.value = true; });
}, { immediate: true });
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
.log-hint { text-transform: none; letter-spacing: 0; color: var(--jg-green); font-weight: 400; }
.log-status { font-size: 9px; padding: 1px 6px; border: 1px solid var(--jg-border); letter-spacing: 0.05em; }
.ls--running   { color: var(--jg-green); border-color: var(--jg-green); }
.ls--completed { color: var(--jg-green); }
.ls--failed    { color: var(--jg-red); border-color: var(--jg-red); }
.ls--cancelled { color: var(--jg-red); }

.log-views { display: flex; gap: 4px; }
.log-view-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; font-size: 10px; font-family: inherit; cursor: pointer;
  background: transparent; color: var(--jg-text-faint);
  border: 1px solid var(--jg-border); border-radius: var(--radius);
}
.log-view-btn--on { color: var(--jg-green); border-color: var(--jg-green); }
.log-view-btn .pi { font-size: 9px; }

.log-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }

.log-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; flex: 1; color: var(--jg-text-faint); font-size: 12px; text-align: center;
}
.log-empty-icon { font-size: 24px; }
.log-empty-hint { font-size: 11px; opacity: 0.7; }

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
