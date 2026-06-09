<template>
  <div class="log-root">
    <div class="log-toolbar">
      <div class="log-title">
        <i class="pi pi-desktop" /> Plan Logs
        <span v-if="group" class="log-status" :class="`ls--${group.status}`">{{ group.status }}</span>
      </div>
    </div>
    <div v-if="!hasLogs" class="log-empty">
      <i class="pi pi-desktop log-empty-icon" />
      <div>No logs for this plan yet. Press Run to start its pipeline.</div>
    </div>
    <div ref="logContainerRef" class="log-terminal" :class="{ 'log-terminal--hidden': !hasLogs }" />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useOrchestrationStore } from '../stores/orchestration.js';
import { useLogTerminal } from '../composables/useLogTerminal.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId);
const orch = useOrchestrationStore();

const group = computed(() => orch.groups[featureId.value] || null);
const logString = computed(() => (group.value?.log || []).join('\n'));

const { logContainerRef, hasLogs } = useLogTerminal(logString);

onMounted(async () => {
  // Replay history when arriving fresh (store may be empty after reload).
  if (!group.value?.log?.length) {
    try {
      const res = await fetch(`/api/projects/${projectId.value}/orchestration`);
      if (!res.ok) return;
      const view = await res.json();
      if (view && Array.isArray(view.groups) && view.groups.length) orch.hydrate(view);
    } catch {}
  }
});
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
.log-status { font-size: 9px; padding: 1px 6px; border: 1px solid var(--jg-border); letter-spacing: 0.05em; }
.ls--running   { color: var(--jg-green); border-color: var(--jg-green); }
.ls--completed { color: var(--jg-green); }
.ls--failed    { color: var(--jg-red); border-color: var(--jg-red); }
.ls--cancelled { color: var(--jg-red); }

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
