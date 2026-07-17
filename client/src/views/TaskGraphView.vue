<template>
  <div class="graph-root">
    <div class="graph-toolbar">
      <div class="graph-title">
        <i class="pi pi-share-alt" /> Task Graph
        <span class="graph-count">{{ tasks.length }} task{{ tasks.length === 1 ? '' : 's' }}</span>
      </div>
      <div class="graph-legend">
        <span class="lg"><i class="lg-dot lg--pending" /> pending</span>
        <span class="lg"><i class="lg-dot lg--in_progress" /> running</span>
        <span class="lg"><i class="lg-dot lg--completed" /> done</span>
        <span class="lg"><i class="lg-dot lg--blocked" /> blocked</span>
      </div>
      <button class="g-btn" :disabled="loading" @click="load" title="Refresh"><i class="pi pi-refresh" /></button>
    </div>

    <p v-if="error" class="graph-error">{{ error }}</p>

    <div v-if="!tasks.length && !loading" class="graph-empty">
      <i class="pi pi-share-alt" />
      <p>No tasks for this plan yet.</p>
    </div>

    <div v-else class="graph-canvas">
      <VueFlow
        :nodes="graph.nodes"
        :edges="graph.edges"
        :default-viewport="{ zoom: 0.85, x: 0, y: 0 }"
        :min-zoom="0.2" :max-zoom="1.6"
        fit-view-on-init
      >
        <Background :gap="22" :size="1" pattern-color="rgba(255,255,255,0.04)" />
        <Controls position="bottom-left" />
        <MiniMap position="bottom-right" pannable zoomable />
        <template #node-taskNode="{ data }">
          <div :class="['gnode', `gnode--${data.status}`]">
            <div class="gnode-head">
              <span class="gnode-id">{{ data.id }}</span>
              <span class="gnode-dot" :class="`lg--${data.status}`" :title="data.status" />
            </div>
            <div class="gnode-title">{{ data.title }}</div>
            <div v-if="data.files?.length" class="gnode-file">{{ data.files[0] }}{{ data.files.length > 1 ? ` +${data.files.length - 1}` : '' }}</div>
            <button
              v-if="canRun(data.status)"
              class="gnode-run"
              :disabled="runningId === data.id"
              @click.stop="runTask(data.id)"
            >
              <i :class="runningId === data.id ? 'pi pi-spin pi-spinner' : 'pi pi-play'" /> Run
            </button>
          </div>
        </template>
      </VueFlow>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { VueFlow, MarkerType } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import { buildTaskGraph } from '../utils/taskGraph.js';
import { useTasksStore } from '../stores/tasks.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId);

const tasksStore = useTasksStore();
const tasks = computed(() => tasksStore.visible);
const loading = ref(false);
const error = ref('');
const runningId = ref(null);

const STATUS_STROKE = {
  completed: '#4ade80',
  in_progress: '#fbbf24',
  blocked: '#f87171',
  failed: '#f87171',
};

// Build graph, then re-style edges for the dark theme + add dependency arrows.
const graph = computed(() => {
  const g = buildTaskGraph(tasks.value);
  const byId = Object.fromEntries(tasks.value.map(t => [t.id, t]));
  g.edges = g.edges.map(e => {
    const target = byId[e.target];
    const stroke = (target && STATUS_STROKE[target.status]) || 'rgba(255,255,255,0.18)';
    return {
      ...e,
      animated: target?.status === 'in_progress',
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
      style: { stroke, strokeWidth: 1.8 },
    };
  });
  return g;
});

const canRun = (status) => !['completed', 'done', 'skipped', 'in_progress'].includes(status);

async function load() {
  loading.value = true; error.value = '';
  try {
    await tasksStore.fetchTasks(projectId.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function runTask(taskId) {
  runningId.value = taskId; error.value = '';
  try {
    const res = await fetch(`/api/projects/${projectId.value}/orchestration/groups/${featureId.value}/run-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      error.value = d.error?.message || `Failed (${res.status})`;
    }
  } catch (e) {
    error.value = e.message;
  }
  runningId.value = null;
}

onMounted(() => {
  tasksStore.setFeatureFilter(featureId.value);
  load();
});

watch(featureId, (fid) => {
  tasksStore.setFeatureFilter(fid);
  load();
});

onUnmounted(() => {
  tasksStore.setFeatureFilter(null);
});
</script>

<style scoped>
.graph-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.graph-toolbar {
  display: flex; align-items: center; gap: 16px;
  padding: 8px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.graph-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--jg-text-faint); display: flex; align-items: center; gap: 6px;
}
.graph-count { text-transform: none; letter-spacing: 0; color: var(--jg-text-muted); font-weight: 400; }
.graph-legend { display: flex; gap: 12px; margin-left: auto; }
.lg { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--jg-text-faint); }
.lg-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.lg--pending     { background: var(--jg-text-faint); }
.lg--in_progress { background: #fbbf24; }
.lg--completed   { background: var(--jg-green); }
.lg--blocked,
.lg--failed      { background: var(--jg-red); }
.lg--skipped     { background: var(--jg-text-faint); opacity: 0.5; }

.g-btn {
  padding: 5px 9px; border: 1px solid var(--jg-border); background: var(--jg-hover);
  color: var(--jg-text-muted); cursor: pointer; border-radius: var(--radius); font-size: 12px;
}
.g-btn:hover:not(:disabled) { color: var(--jg-text); }

.graph-error { color: var(--jg-red); font-size: 12px; margin: 8px 16px 0; }
.graph-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; flex: 1; color: var(--jg-text-faint); font-size: 12px;
}
.graph-empty .pi { font-size: 26px; }

.graph-canvas { flex: 1; overflow: hidden; background: var(--jg-bg); }

/* node */
.gnode {
  width: 200px; padding: 10px 12px;
  background: var(--jg-card); border: 1px solid var(--jg-border);
  border-radius: var(--radius); border-left-width: 3px;
}
.gnode--pending     { border-left-color: var(--jg-text-faint); }
.gnode--in_progress { border-left-color: #fbbf24; box-shadow: 0 0 0 1px color-mix(in oklch, #fbbf24 30%, transparent); }
.gnode--completed   { border-left-color: var(--jg-green); }
.gnode--blocked,
.gnode--failed      { border-left-color: var(--jg-red); }
.gnode--skipped     { border-left-color: var(--jg-text-faint); opacity: 0.6; }

.gnode-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.gnode-id { font-size: 10px; font-family: var(--font-mono); color: var(--jg-text-faint); }
.gnode-dot { width: 7px; height: 7px; border-radius: 50%; }
.gnode-title { font-size: 12px; font-weight: 600; color: var(--jg-text); line-height: 1.35; }
.gnode-file { font-size: 9px; color: var(--jg-text-faint); margin-top: 4px; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gnode-run {
  margin-top: 8px; display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; font-size: 10px; font-family: inherit; cursor: pointer;
  background: var(--jg-hover); color: var(--jg-text-muted);
  border: 1px solid var(--jg-border); border-radius: var(--radius); transition: all 0.15s;
}
.gnode-run:hover:not(:disabled) { color: var(--jg-green); border-color: var(--jg-green); }
.gnode-run:disabled { opacity: 0.5; cursor: not-allowed; }
.gnode-run .pi { font-size: 9px; }

/* vue-flow chrome tuned to dark theme */
.graph-canvas :deep(.vue-flow__controls) { box-shadow: none; }
.graph-canvas :deep(.vue-flow__controls-button) {
  background: var(--jg-card); border-color: var(--jg-border); fill: var(--jg-text-muted);
}
.graph-canvas :deep(.vue-flow__minimap) { background: var(--jg-card); }
</style>
