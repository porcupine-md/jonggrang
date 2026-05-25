<template>
  <div class="kanban-header">
    <div class="header-left">
      <div class="header-stats">
        <span class="stats-text">{{ tasks.stats.done }}/{{ tasks.stats.total }} tasks</span>
        <ProgressBar :value="tasks.stats.pct" style="width:120px;height:4px" :showValue="false" />
        <span class="stats-pct">{{ tasks.stats.pct }}%</span>
      </div>
      <div v-if="proc.isRunning" class="running-badge">
        <span class="running-dot"></span>
        {{ proc.running.command }} running
        <span class="elapsed">{{ formatElapsed(proc.elapsed) }}</span>
      </div>
    </div>
    <div class="header-right">
      <Button
        v-if="!proc.isRunning && canWork"
        size="small"
        :disabled="working"
        @click="startWork"
      >
        <i :class="isInterrupted ? 'pi pi-refresh' : 'pi pi-play'" />
        {{ isInterrupted ? 'Resume Work' : 'Start Work' }}
      </Button>
      <Button
        v-if="proc.isRunning && proc.running?.command === 'work'"
        size="small"
        severity="danger"
        @click="cancelWork"
      >
        <i class="pi pi-times" /> Cancel
      </Button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import Button from 'primevue/button';
import ProgressBar from 'primevue/progressbar';
import { useTasksStore } from '../../stores/tasks.js';
import { useProcessStore } from '../../stores/process.js';
import { useProjectsStore } from '../../stores/projects.js';

const props = defineProps({ projectId: String });
const tasks = useTasksStore();
const proc = useProcessStore();
const projects = useProjectsStore();

const working = ref(false);
const project = computed(() => projects.byId[props.projectId]);
const state = computed(() => project.value?.derived_state?.state || 'idle');
const canWork = computed(() => ['tasks_pending', 'working', 'done'].includes(state.value) || tasks.tasks.length > 0);
// Interrupted = some tasks are in_progress but no process is running (crashed/stopped)
const isInterrupted = computed(() =>
  state.value === 'working' && !proc.isRunning
);

async function startWork() {
  working.value = true;
  try {
    const body = isInterrupted.value ? { resume: true } : {};
    await fetch(`/api/projects/${props.projectId}/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
  working.value = false;
}

async function cancelWork() {
  await fetch(`/api/projects/${props.projectId}/cancel`, { method: 'POST' });
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
</script>

<style scoped>
.kanban-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
  background: var(--jg-card);
}
.header-left { display: flex; align-items: center; gap: 16px; }
.header-stats { display: flex; align-items: center; gap: 8px; }
.stats-text { font-size: 12px; color: var(--jg-text-muted); }
.stats-pct { font-size: 12px; color: var(--jg-text-faint); }
.running-badge { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--jg-green); }
.running-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--jg-green); animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.elapsed { color: var(--jg-text-faint); }
.header-right { display: flex; gap: 8px; }
</style>
