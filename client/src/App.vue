<script setup>
import { ref, computed, watch } from 'vue';
import { useJonggrangApi } from './composables/useJonggrangApi';
import { useJonggrangActions } from './composables/useJonggrangActions';
import { useLogTerminal } from './composables/useLogTerminal';
import { useJonggrangRuntime } from './composables/useJonggrangRuntime';
import { buildTaskGraph } from './utils/taskGraph';
import {
  PHASES_UI,
  TASK_COLUMNS,
  chunkIntoRows,
  classifyWorkType,
  getWorkTypeHint,
  phaseNumbers,
} from './utils/appUi';
import TopBar from './components/app/TopBar.vue';
import PipelinePanel from './components/app/PipelinePanel.vue';
import TaskDetailPanel from './components/app/TaskDetailPanel.vue';
import TaskBoard from './components/app/TaskBoard.vue';
import TaskGraph from './components/app/TaskGraph.vue';
import WorkModal from './components/app/WorkModal.vue';
import PlanModal from './components/app/PlanModal.vue';
import NewTaskModal from './components/app/NewTaskModal.vue';
import ErrorBanner from './components/app/ErrorBanner.vue';
import LogPanelShell from './components/app/LogPanelShell.vue';

// ── STATE ─────────────────────────────────────────────────────
const currentView    = ref('kanban'); // 'kanban' | 'graph'
const selectedTaskId = ref(null);
const showLogPanel   = ref(true);
const showNewTaskForm = ref(false);
const showPlanModal    = ref(false);
const planStage        = ref('describe'); // 'describe' | 'review'
const planDesc         = ref('');
const pendingPlan      = ref('');         // plan.md content for review
const showWorkModal    = ref(false);
const newTask          = ref({ title: '', description: '', priority: 1 });
const workDesc         = ref('');

const { requestError, clearRequestError, setRequestError, requestJson } = useJonggrangApi();
const {
  isRunning,
  logs,
  rawTasks,
  projectConfig,
  activeManifest,
  compactionState,
  fetchManifest,
  fetchManifests,
  startManifestPoll,
  clearLogs: clearRuntimeLogs,
} = useJonggrangRuntime({
  requestJson,
  reportError: setRequestError,
  onPlanUpdate: (d) => {
    if (d?.exists && d.content) {
      pendingPlan.value = d.content;
      if (showPlanModal.value && planStage.value === 'describe') {
        planStage.value = 'review';
      }
    } else {
      pendingPlan.value = '';
    }
  },
});
const { logContainerRef, hasLogs, logLineCount, clearTerminal } = useLogTerminal(logs);

function clearLogs() {
  clearTerminal();
  clearRuntimeLogs();
}

const {
  runWork,
  runPlan,
  stopWork,
  startTask,
  startReview,
  addTask,
  deleteTask,
  updateStatus,
  resumePipeline,
} = useJonggrangActions({
  requestJson,
  clearRequestError,
  setRequestError,
  projectConfig,
  activeManifest,
  fetchManifest,
  fetchManifests,
  startManifestPoll,
  clearLogs,
  selectedTaskId,
  showWorkModal,
  workDesc,
  showPlanModal,
  planDesc,
  newTask,
  showNewTaskForm,
});

// ── COMPUTED ──────────────────────────────────────────────────
const projectName = computed(() => projectConfig.value?.name || 'Jonggrang');
const selectedTask = computed(() => {
  if (!selectedTaskId.value) return null;
  return rawTasks.value.find(task => task.id === selectedTaskId.value) ?? null;
});

const columns = computed(() => TASK_COLUMNS.map((column) => ({
  ...column,
  tasks: rawTasks.value.filter(task => column.include.includes(task.status)),
  count: rawTasks.value.filter(task => column.include.includes(task.status)).length,
})));

const totalTasks     = computed(() => rawTasks.value.length);
const completedTasks = computed(() => rawTasks.value.filter(t => t.status === 'completed').length);
const progressPct    = computed(() =>
  totalTasks.value === 0 ? 0 : Math.round((completedTasks.value / totalTasks.value) * 100)
);

const ctxPct = computed(() =>
  compactionState.value?.ratio != null ? Math.round(compactionState.value.ratio * 100) : null
);
const workType = computed(() => classifyWorkType(workDesc.value));
const workTypeHint = computed(() => getWorkTypeHint(workType.value));

// Active pipeline (most recent running or last completed)
const pipelineManifest = computed(() => activeManifest.value?.manifest ?? null);
const loadingPhaseRows = computed(() => chunkIntoRows(phaseNumbers, 4));

// Phase grid rows (4-per-row)
const phaseRows = computed(() => {
  const m = pipelineManifest.value;
  if (!m) return [];
  return loadingPhaseRows.value.map(row => row.map(n => {
    const active = m.active_phases?.includes(n);
    const status = m.phases?.[n]?.status || 'pending';
    const isCurrent = m.current_phase === n;
    return { n, ...PHASES_UI[n], active, status, isCurrent };
  }));
});

const qualityGates = computed(() => {
  const v = pipelineManifest.value?.validation || {};
  return [
    { label: 'Review',   ok: v.review_passed },
    { label: 'Tests',    ok: v.tests_passed },
    { label: 'Coverage', ok: v.coverage_met },
  ];
});
watch(rawTasks, (tasks) => {
  if (!selectedTaskId.value) return;
  if (!tasks.some(task => task.id === selectedTaskId.value)) {
    selectedTaskId.value = null;
  }
});

// ── GRAPH ─────────────────────────────────────────────────────
const graphNodes = computed(() => buildTaskGraph(rawTasks.value));

async function copyLogs() {
  if (!logs.value) return;
  try {
    await navigator.clipboard.writeText(logs.value);
  } catch (error) {
    setRequestError(error, 'Failed to copy logs.');
  }
}

function openPlanModal() {
  if (pendingPlan.value) {
    planStage.value = 'review';
  } else {
    planStage.value = 'describe';
    planDesc.value = '';
  }
  showPlanModal.value = true;
}

async function approvePlan() {
  try {
    if (pendingPlan.value) {
      await requestJson('/api/jonggrang/plan/content', { method: 'PUT', body: { content: pendingPlan.value } });
    }
    clearLogs();
    showPlanModal.value = false;
    await requestJson('/api/jonggrang/approve', { method: 'POST', body: {} });
  } catch (err) {
    setRequestError(err, 'Failed to approve plan.');
  }
}

async function discardPlan() {
  try {
    await requestJson('/api/jonggrang/plan/content', { method: 'DELETE' });
  } catch { /* ignore */ }
  pendingPlan.value = '';
  showPlanModal.value = false;
}

function selectTask(task) {
  selectedTaskId.value = selectedTaskId.value === task.id ? null : task.id;
}
</script>

<template>
  <div class="app">
    <TopBar
      :project-name="projectName"
      :current-view="currentView"
      :ctx-pct="ctxPct"
      :is-running="isRunning"
      :has-pending-plan="!!pendingPlan"
      @select-view="currentView = $event"
      @open-plan="openPlanModal"
      @start-review="startReview"
      @open-work="showWorkModal = true"
      @stop-work="stopWork"
      @toggle-logs="showLogPanel = !showLogPanel"
    />

    <!-- progress strip -->
    <div v-if="totalTasks > 0" class="progress-strip">
      <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
    </div>

    <ErrorBanner v-if="requestError" :message="requestError" @dismiss="clearRequestError" />

    <!-- ══════════════ MAIN LAYOUT ══════════════ -->
    <div class="main-layout">

      <!-- ── CONTENT (kanban / graph) ── -->
      <div class="content-area">
        <TaskBoard
          v-if="currentView === 'kanban'"
          :columns="columns"
          :selected-task-id="selectedTaskId"
          :is-running="isRunning"
          @select-task="selectTask"
          @start-task="startTask"
          @delete-task="deleteTask"
          @update-status="updateStatus"
          @open-new-task="showNewTaskForm = true"
        />

        <TaskGraph
          v-else-if="currentView === 'graph'"
          :graph-nodes="graphNodes"
          @select-task="selectTask"
        />

      </div><!-- /content-area -->

      <!-- ── SIDE PANEL ── -->
      <div v-if="showLogPanel" class="side-panel">
        <PipelinePanel
          :is-running="isRunning"
          :pipeline-manifest="pipelineManifest"
          :loading-phase-rows="loadingPhaseRows"
          :phase-rows="phaseRows"
          :quality-gates="qualityGates"
          @resume="resumePipeline"
        />

        <LogPanelShell
          :is-running="isRunning"
          :has-logs="hasLogs"
          :log-line-count="logLineCount"
          @copy-logs="copyLogs"
          @clear-logs="clearLogs"
        >
          <div ref="logContainerRef" class="terminal-host"></div>
        </LogPanelShell>

      </div><!-- /side-panel -->

      <!-- Task detail sidebar -->
      <TaskDetailPanel
        v-if="selectedTask && currentView === 'kanban'"
        :task="selectedTask"
        :raw-tasks="rawTasks"
        :is-running="isRunning"
        @close="selectedTaskId = null"
        @start-task="startTask"
        @delete-task="deleteTask"
      />

    </div><!-- /main-layout -->

    <!-- ══════════════ MODALS ══════════════ -->

    <WorkModal
      :show="showWorkModal"
      :description="workDesc"
      :work-type="workType"
      :work-type-hint="workTypeHint"
      @close="showWorkModal = false"
      @update:description="workDesc = $event"
      @run="runWork"
    />

    <PlanModal
      :show="showPlanModal"
      :description="planDesc"
      :stage="planStage"
      :pending-plan="pendingPlan"
      :is-running="isRunning"
      @close="showPlanModal = false"
      @update:description="planDesc = $event"
      @update:pending-plan="pendingPlan = $event"
      @run="runPlan"
      @approve="approvePlan"
      @discard="discardPlan"
      @back="planStage = 'describe'"
    />

    <NewTaskModal
      :show="showNewTaskForm"
      :title="newTask.title"
      :description="newTask.description"
      @close="showNewTaskForm = false"
      @update:title="newTask.title = $event"
      @update:description="newTask.description = $event"
      @create="addTask"
    />

  </div><!-- /app -->
</template>

<style>
.app { display: flex; flex-direction: column; height: 100vh; }

/* ── PROGRESS STRIP ── */
.progress-strip { height: 2px; background: var(--border-subtle); flex-shrink: 0; }
.progress-fill  { height: 100%; background: var(--green); transition: width 0.4s; }
/* ── MAIN LAYOUT ── */
.main-layout {
  flex: 1; display: flex; overflow: hidden;
}

.content-area { flex: 1; overflow: hidden; display: flex; }

/* ── SIDE PANEL ── */
.side-panel {
  width: 320px; flex-shrink: 0;
  display: flex; flex-direction: column;
  border-left: 1px solid var(--border-subtle);
  overflow: hidden;
}

.terminal-host {
  height: 100%;
}
</style>
