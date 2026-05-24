<template>
  <div class="kanban-header">
    <div class="header-left">
      <div class="header-stats">
        <span class="stats-text">{{ tasks.stats.done }}/{{ tasks.stats.total }} tasks</span>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: tasks.stats.pct + '%' }"></div>
        </div>
        <span class="stats-pct">{{ tasks.stats.pct }}%</span>
      </div>
      <div v-if="proc.isRunning" class="running-badge">
        <span class="running-dot"></span>
        {{ proc.running.command }} running
        <span class="elapsed">{{ formatElapsed(proc.elapsed) }}</span>
      </div>
    </div>
    <div class="header-right">
      <button
        v-if="!proc.isRunning && canWork"
        class="btn btn--primary btn--sm"
        :disabled="working"
        @click="startWork"
      >▶ Start Work</button>
      <button
        v-if="proc.isRunning && proc.running?.command === 'work'"
        class="btn btn--danger btn--sm"
        @click="cancelWork"
      >✕ Cancel</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
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

async function startWork() {
  working.value = true;
  try {
    await fetch(`/api/projects/${props.projectId}/work`, { method: 'POST' });
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
  padding: 10px 16px; border-bottom: 1px solid #1e1f2a; flex-shrink: 0;
  background: #0d0e14;
}
.header-left { display: flex; align-items: center; gap: 16px; }
.header-stats { display: flex; align-items: center; gap: 8px; }
.stats-text { font-size: 12px; color: #6b7280; }
.progress-bar { width: 120px; height: 4px; background: #1e1f2a; border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: #7c3aed; transition: width 0.3s; }
.stats-pct { font-size: 12px; color: #9ca3af; }
.running-badge { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #34d399; }
.running-dot { width: 6px; height: 6px; border-radius: 50%; background: #34d399; animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.elapsed { color: #6b7280; }
.header-right { display: flex; gap: 8px; }
</style>
