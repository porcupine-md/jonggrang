<script setup>
import { ref, shallowRef, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue';
import { io } from 'socket.io-client';
import { VueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import {
  PlayIcon, SquareIcon, LayoutGridIcon, GitBranchIcon,
  PlusIcon, XIcon, CheckCircle2Icon, CircleDotIcon,
  CircleIcon, CircleAlertIcon, PencilIcon, TrashIcon,
  ChevronDownIcon, FileTextIcon, EyeIcon, ZapIcon,
  ClockIcon, Loader2Icon, BookOpenIcon, ActivityIcon,
} from 'lucide-vue-next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const socket = io({ transports: ['websocket'] });

// ── STATE ─────────────────────────────────────────────────────
const isRunning     = ref(false);
const logs          = ref('');
const rawTasks      = ref([]);
const projectConfig = ref(null);

// UI
const currentView    = ref('kanban'); // 'kanban' | 'graph'
const selectedTask   = ref(null);
const showLogPanel   = ref(true);
const showNewTaskForm = ref(false);
const showPlanModal  = ref(false);
const showWorkModal  = ref(false);
const newTask        = ref({ title: '', description: '', priority: 1 });
const planDesc       = ref('');
const workDesc       = ref('');

// Pipeline / manifest
const manifests       = ref([]);
const activeManifest  = ref(null);
const compactionState = ref(null);
let   manifestPollTimer = null;

// Phase UI definitions
const PHASES_UI = {
  1:  { name: 'Setup',        role: null },
  2:  { name: 'Triage',       role: null },
  3:  { name: 'Discovery',    role: null },
  4:  { name: 'Skill Map',    role: null },
  5:  { name: 'Complexity',   role: 'lead' },
  6:  { name: 'Brainstorm',   role: 'lead' },
  7:  { name: 'Architect',    role: 'lead' },
  8:  { name: 'Implement',    role: 'developer' },
  9:  { name: 'Design Check', role: 'reviewer' },
  10: { name: 'Compliance',   role: 'reviewer' },
  11: { name: 'Quality',      role: 'reviewer' },
  12: { name: 'Test Plan',    role: 'test-lead' },
  13: { name: 'Testing',      role: 'tester' },
  14: { name: 'Coverage',     role: 'tester' },
  15: { name: 'Test Quality', role: 'reviewer' },
  16: { name: 'Complete',     role: 'lead' },
};
const ROLE_COLORS = {
  lead: '#8b5cf6', developer: '#3b82f6',
  reviewer: '#f59e0b', 'test-lead': '#06b6d4', tester: '#10b981',
};
const WORK_TYPE_COLORS = {
  BUGFIX: '#ef4444', SMALL: '#10b981', MEDIUM: '#f59e0b', LARGE: '#8b5cf6',
};

// ── COMPUTED ──────────────────────────────────────────────────
const projectName = computed(() => projectConfig.value?.name || 'Jonggrang');

const columns = computed(() => [
  { key: 'pending',    label: 'TODO',        include: ['pending'] },
  { key: 'in_progress',label: 'IN PROGRESS', include: ['in_progress', 'waiting', 'review'] },
  { key: 'completed',  label: 'DONE',        include: ['completed'] },
  { key: 'blocked',    label: 'BLOCKED',     include: ['blocked'] },
].map(col => ({
  ...col,
  tasks: rawTasks.value.filter(t => col.include.includes(t.status)),
  count: rawTasks.value.filter(t => col.include.includes(t.status)).length,
})));

const totalTasks     = computed(() => rawTasks.value.length);
const completedTasks = computed(() => rawTasks.value.filter(t => t.status === 'completed').length);
const progressPct    = computed(() =>
  totalTasks.value === 0 ? 0 : Math.round((completedTasks.value / totalTasks.value) * 100)
);

const ctxPct = computed(() =>
  compactionState.value?.ratio != null ? Math.round(compactionState.value.ratio * 100) : null
);

// Work type preview (live as user types)
const workType = computed(() => {
  const d = workDesc.value.trim().toLowerCase();
  if (!d) return null;
  const isBugfix = /\b(fix|bug|broken|crash|typo|hotfix|regression)\b/.test(d) ||
    /\berror\b(?!\s*(message|handling|response|code|log|output|format))/.test(d);
  if (isBugfix) return 'BUGFIX';
  const isLarge = /\b(subsystem|architecture|refactor|migrate|overhaul|redesign|platform|infrastructure|framework)\b/.test(d) ||
    /\b(authentication|authorization|auth system|checkout|billing|subscription)\b/.test(d) ||
    /\bpayment\b.{0,40}\b(flow|system|integration|gateway|processor|webhook)\b/.test(d) ||
    (d.match(/,/g) || []).length >= 3;
  if (isLarge) return 'LARGE';
  const isMedium = /\b(implement|build|create|develop|setup|integrate)\b.{0,80}\b(with|including|plus)\b/.test(d) ||
    /\b(module|service|flow|handler|integration|pipeline|workflow)\b/.test(d);
  if (isMedium) return 'MEDIUM';
  return 'SMALL';
});

// Active pipeline (most recent running or last completed)
const pipelineManifest = computed(() => activeManifest.value?.manifest ?? null);
const pipelineRunning  = computed(() =>
  ['running', 'in_progress'].includes(pipelineManifest.value?.status)
);

// Phase grid rows (4-per-row)
const phaseRows = computed(() => {
  const m = pipelineManifest.value;
  if (!m) return [];
  const nums = Object.keys(PHASES_UI).map(Number);
  const rows = [];
  for (let i = 0; i < nums.length; i += 4) {
    rows.push(nums.slice(i, i + 4).map(n => {
      const active   = m.active_phases?.includes(n);
      const status   = m.phases?.[n]?.status || 'pending';
      const isCurrent = m.current_phase === n;
      return { n, ...PHASES_UI[n], active, status, isCurrent };
    }));
  }
  return rows;
});

const qualityGates = computed(() => {
  const v = pipelineManifest.value?.validation || {};
  return [
    { label: 'Review',   ok: v.review_passed },
    { label: 'Tests',    ok: v.tests_passed },
    { label: 'Coverage', ok: v.coverage_met },
  ];
});

// ── GRAPH ─────────────────────────────────────────────────────
const graphNodes = computed(() => {
  const tasks = rawTasks.value;
  const nodes = [];
  const edges = [];
  const levelMap = new Map();
  const nodeLevels = new Map();
  const roots = tasks.filter(t => !t.blocked_by || t.blocked_by.length === 0);
  function assignLevel(id, lvl) {
    if ((nodeLevels.get(id) ?? -1) < lvl) {
      nodeLevels.set(id, lvl);
      tasks.filter(t => t.blocked_by?.includes(id)).forEach(c => assignLevel(c.id, lvl + 1));
    }
  }
  roots.forEach(r => assignLevel(r.id, 0));
  tasks.forEach(task => {
    const lvl  = nodeLevels.get(task.id) ?? 0;
    const col  = (levelMap.get(lvl) || []).length;
    const x    = col * 260 + (lvl % 2 === 1 ? 100 : 0) + 60;
    const y    = lvl * 140 + 60;
    levelMap.set(lvl, [...(levelMap.get(lvl) || []), task]);
    nodes.push({ id: task.id, position: { x, y }, data: { ...task }, type: 'taskNode' });
    (task.blocked_by || []).forEach(blocker => {
      edges.push({
        id: `e-${blocker}-${task.id}`,
        source: blocker, target: task.id,
        animated: task.status === 'in_progress',
        style: { stroke: task.status === 'completed' ? 'var(--green)' : 'rgba(255,255,255,0.12)', strokeWidth: 2 },
      });
    });
  });
  return { nodes, edges };
});

// ── TERMINAL ──────────────────────────────────────────────────
const logContainerRef  = ref(null);
const terminalInstance = shallowRef(null);
const fitAddon         = shallowRef(null);
const logContentLength = ref(0);
let resizeObserver = null;

function renderFullLog() {
  const term = terminalInstance.value;
  if (!term) return;
  term.clear();
  if (logs.value) {
    term.write(logs.value.replace(/\r?\n/g, '\r\n'));
    logContentLength.value = logs.value.length;
    term.scrollToBottom();
  }
}

function attachTerminal(el) {
  const term = terminalInstance.value;
  if (!term || !el) return;
  el.innerHTML = '';
  if (term.element) el.appendChild(term.element);
  else term.open(el);
  requestAnimationFrame(() => {
    fitAddon.value?.fit();
    renderFullLog();
  });
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => fitAddon.value?.fit()));
  resizeObserver.observe(el);
}

watch(logContainerRef, el => {
  if (el && terminalInstance.value) nextTick(() => attachTerminal(el));
}, { flush: 'post' });

watch(logs, (newVal) => {
  const term = terminalInstance.value;
  const el   = logContainerRef.value;
  if (!term || !el) return;
  if (!term.element || !el.contains(term.element)) { attachTerminal(el); return; }
  if (!newVal || newVal.length < logContentLength.value) { renderFullLog(); return; }
  const diff = newVal.slice(logContentLength.value);
  if (diff) {
    term.write(diff.replace(/\r?\n/g, '\r\n'));
    logContentLength.value = newVal.length;
    term.scrollToBottom();
  }
}, { flush: 'post' });

// ── SOCKET ────────────────────────────────────────────────────
onMounted(() => {
  socket.on('jonggrang_status', d => { isRunning.value = d.isRunning; });
  socket.on('tasks_update', d => {
    if (d?.tasks) rawTasks.value = d.tasks;
  });
  socket.on('config_update', d => { if (d) projectConfig.value = d; });
  socket.on('log', d => {
    logs.value += typeof d === 'string' ? d : (d?.data || '');
  });
  socket.on('orchestration_complete', ({ featureId }) => {
    stopManifestPoll();
    if (activeManifest.value?.featureId === featureId) fetchManifest(featureId);
    fetchManifests();
  });
  // Real-time manifest updates from server-side chokidar watcher
  socket.on('manifests_update', (list) => {
    manifests.value = list;
    // Always follow the running manifest; fall back to current active; then most recent
    const running = list.find(m => m.status === 'running' || m.status === 'in_progress');
    const active  = activeManifest.value?.featureId;
    const target  = running || (active ? list.find(m => m.featureId === active) : null) || list[0];
    if (target) {
      activeManifest.value = {
        featureId: target.featureId,
        manifest: {
          description:   target.description,
          work_type:     target.workType,
          status:        target.status,
          current_phase: target.currentPhase,
          active_phases: target.activePhases,
          phases:        target.phases,
          validation:    target.validation,
        },
      };
    }
  });
});

// ── LIFECYCLE ─────────────────────────────────────────────────
onMounted(() => {
  const term = new Terminal({
    convertEol: true, scrollback: 5000, fontSize: 12,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    theme: {
      background: '#05060a', foreground: '#f4f4f5',
      cursor: '#38bdf8', cursorAccent: '#05060a',
      selectionBackground: 'rgba(56,189,248,0.25)',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  terminalInstance.value = term;
  fitAddon.value = fit;
  window.addEventListener('resize', () => requestAnimationFrame(() => fitAddon.value?.fit()));
  nextTick(() => { if (logContainerRef.value) attachTerminal(logContainerRef.value); });
  fetchManifests();
  fetchCompaction();
  setInterval(fetchCompaction, 10000);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  terminalInstance.value?.dispose();
  stopManifestPoll();
});

// ── ACTIONS ───────────────────────────────────────────────────
async function api(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function clearLogs() {
  logs.value = '';
  logContentLength.value = 0;
  terminalInstance.value?.clear();
}

async function runWork() {
  if (!workDesc.value.trim()) return;
  clearLogs();
  showWorkModal.value = false;
  const tool = projectConfig.value?.tool || 'opencode';
  const res = await api('/api/jonggrang/start', { tool, description: workDesc.value.trim() });
  if (res.featureId) {
    await fetchManifest(res.featureId);
    startManifestPoll(res.featureId);
  } else {
    // Poll for manifest that will be created once planning completes
    startManifestPoll(null);
  }
  workDesc.value = '';
  fetchManifests();
}

async function runPlan() {
  if (!planDesc.value.trim()) return;
  clearLogs();
  await api('/api/jonggrang/plan', { description: planDesc.value });
  showPlanModal.value = false;
  planDesc.value = '';
}

async function stopWork() {
  await api('/api/jonggrang/stop');
}

async function startTask(taskId) {
  clearLogs();
  const tool = projectConfig.value?.tool || 'opencode';
  await api('/api/jonggrang/start', { taskId, tool });
}

async function startReview() {
  clearLogs();
  await api('/api/jonggrang/review');
}

async function addTask() {
  if (!newTask.value.title.trim()) return;
  await api('/api/jonggrang/tasks', newTask.value);
  newTask.value = { title: '', description: '', priority: 1 };
  showNewTaskForm.value = false;
}

async function deleteTask(id) {
  await fetch(`/api/jonggrang/tasks/${id}`, { method: 'DELETE' });
  if (selectedTask.value?.id === id) selectedTask.value = null;
}

async function updateStatus(id, status) {
  await fetch(`/api/jonggrang/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

function selectTask(task) {
  selectedTask.value = selectedTask.value?.id === task.id ? null : task;
}

// ── MANIFEST / PIPELINE ───────────────────────────────────────
async function fetchManifests() {
  try {
    const r = await fetch('/api/jonggrang/manifests');
    manifests.value = await r.json();
    // Auto-select most recent
    if (!activeManifest.value && manifests.value.length > 0) {
      await fetchManifest(manifests.value[0].featureId);
      if (['running', 'in_progress'].includes(activeManifest.value?.manifest?.status)) {
        startManifestPoll(manifests.value[0].featureId);
      }
    }
  } catch {}
}

async function fetchManifest(fid) {
  try {
    const r = await fetch(`/api/jonggrang/manifests/${fid}`);
    const d = await r.json();
    if (d.manifest) activeManifest.value = d;
  } catch {}
}

async function fetchCompaction() {
  try {
    const r = await fetch('/api/jonggrang/compaction');
    compactionState.value = await r.json();
  } catch {}
}

function startManifestPoll(fid) {
  stopManifestPoll();
  if (fid) {
    manifestPollTimer = setInterval(() => fetchManifest(fid), 2000);
  } else {
    // Poll all manifests until one appears (then socket events take over)
    manifestPollTimer = setInterval(async () => {
      await fetchManifests();
      if (activeManifest.value) stopManifestPoll();
    }, 2000);
  }
}
function stopManifestPoll() {
  if (manifestPollTimer) { clearInterval(manifestPollTimer); manifestPollTimer = null; }
}

async function resumePipeline() {
  clearLogs();
  const fid = activeManifest.value?.featureId;
  const res = await api('/api/jonggrang/orchestrate/resume', fid ? { featureId: fid } : {});
  if (res.featureId) { await fetchManifest(res.featureId); startManifestPoll(res.featureId); }
}

// ── HELPERS ───────────────────────────────────────────────────
function statusColor(s) {
  return { completed: 'var(--green)', in_progress: 'var(--blue)', waiting: 'var(--yellow)',
    review: 'var(--yellow)', blocked: 'var(--red)' }[s] || 'var(--text-muted)';
}
function statusLabel(s) {
  return { pending: 'Ready', in_progress: 'In Progress', waiting: 'Waiting',
    review: 'Review', completed: 'Done', blocked: 'Blocked' }[s] || s;
}
function statusIcon(s) {
  return { completed: CheckCircle2Icon, in_progress: Loader2Icon, waiting: ClockIcon,
    review: EyeIcon, blocked: CircleAlertIcon }[s] || CircleIcon;
}

function phaseIcon(p) {
  if (!p.active) return '–';
  if (p.status === 'completed') return '✓';
  if (p.status === 'running')   return '⟳';
  if (p.status === 'failed')    return '✗';
  if (p.status === 'skipped')   return '–';
  return '·';
}
function phaseClass(p) {
  if (!p.active) return 'ph-skip';
  if (p.status === 'skipped') return 'ph-skip';
  return { completed: 'ph-done', running: 'ph-run', failed: 'ph-fail' }[p.status] || 'ph-wait';
}

// Drag & drop
let draggedTask = null;
function onDragStart(e, task) { draggedTask = task; e.dataTransfer.effectAllowed = 'move'; }
function onDragOver(e)        { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
function onDrop(e, key)       {
  e.preventDefault();
  if (draggedTask && draggedTask.status !== key) updateStatus(draggedTask.id, key);
  draggedTask = null;
}
</script>

<template>
  <div class="app">

    <!-- ══════════════ TOP BAR ══════════════ -->
    <header class="topbar">
      <div class="topbar-left">
        <span class="project-name">{{ projectName }}</span>
        <ChevronDownIcon :size="13" class="icon-muted" />
      </div>

      <div class="topbar-center">
        <button :class="['tab', { active: currentView === 'kanban' }]" @click="currentView = 'kanban'" title="Task Board">
          <LayoutGridIcon :size="15" />
        </button>
        <button :class="['tab', { active: currentView === 'graph' }]" @click="currentView = 'graph'" title="Dependency Graph">
          <GitBranchIcon :size="15" />
        </button>

        <div class="sep"></div>

        <button class="topbar-btn" @click="showPlanModal = true" title="Plan feature">
          <FileTextIcon :size="15" />
        </button>
        <button class="topbar-btn" @click="startReview" title="Run review">
          <EyeIcon :size="15" />
        </button>

        <div class="sep"></div>

        <button v-if="!isRunning" class="run-btn" @click="showWorkModal = true">
          <PlayIcon :size="13" /><span>Work</span>
        </button>
        <button v-else class="stop-btn" @click="stopWork">
          <SquareIcon :size="12" /><span>Stop</span>
        </button>
      </div>

      <div class="topbar-right">
        <div v-if="ctxPct !== null" class="ctx-badge"
          :class="{ warn: ctxPct >= 75, danger: ctxPct >= 85 }"
          :title="`Context usage: ${ctxPct}%`">
          <ActivityIcon :size="12" />{{ ctxPct }}%
        </div>
        <div class="status-dot" :class="{ active: isRunning }"></div>
        <span class="status-text">{{ isRunning ? 'Running' : 'Idle' }}</span>
        <button class="topbar-btn" @click="showLogPanel = !showLogPanel" title="Toggle logs">
          <BookOpenIcon :size="15" />
        </button>
      </div>
    </header>

    <!-- progress strip -->
    <div v-if="totalTasks > 0" class="progress-strip">
      <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
    </div>

    <!-- ══════════════ MAIN LAYOUT ══════════════ -->
    <div class="main-layout">

      <!-- ── CONTENT (kanban / graph) ── -->
      <div class="content-area">

        <!-- KANBAN -->
        <div v-if="currentView === 'kanban'" class="kanban">
          <div v-for="col in columns" :key="col.key" class="kanban-col"
            @dragover="onDragOver" @drop="e => onDrop(e, col.key)">
            <div class="col-header">
              <span class="col-label">{{ col.label }}</span>
              <span class="col-count" v-if="col.count > 0">{{ col.count }}</span>
            </div>
            <div class="col-body">
              <div v-for="task in col.tasks" :key="task.id"
                :class="['task-card', { selected: selectedTask?.id === task.id, running: task.status === 'in_progress' && isRunning }]"
                draggable="true"
                @dragstart="e => onDragStart(e, task)"
                @click="selectTask(task)">
                <div class="card-bar" :style="{ background: statusColor(task.status) }"></div>
                <div class="card-body">
                  <div class="card-title">{{ task.title }}</div>
                  <div class="card-desc" v-if="task.description && task.description !== task.title">{{ task.description }}</div>
                  <div class="card-footer">
                    <span class="card-id">{{ task.id }}</span>
                    <span class="card-status" :style="{ color: statusColor(task.status) }">{{ statusLabel(task.status) }}</span>
                    <div class="card-actions">
                      <button v-if="task.status === 'pending'" class="card-btn"
                        @click.stop="startTask(task.id)" :disabled="isRunning">
                        <PlayIcon :size="11" />
                      </button>
                      <button class="card-btn danger" @click.stop="deleteTask(task.id)">
                        <XIcon :size="11" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <button v-if="col.key === 'pending'" class="add-btn" @click="showNewTaskForm = true">
                <PlusIcon :size="14" />New task
              </button>
            </div>
          </div>
        </div>

        <!-- GRAPH -->
        <div v-else-if="currentView === 'graph'" class="graph-wrap">
          <VueFlow :nodes="graphNodes.nodes" :edges="graphNodes.edges"
            :default-viewport="{ zoom: 0.85, x: 0, y: 0 }" fit-view-on-init>
            <Background :gap="24" :size="1" pattern-color="rgba(255,255,255,0.03)" />
            <Controls position="bottom-left" />
            <MiniMap position="bottom-right" />
            <template #node-taskNode="{ data }">
              <div :class="['gnode', `gnode--${data.status}`]" @click="selectTask(data)">
                <div class="gnode-id">{{ data.id }}</div>
                <div class="gnode-title">{{ data.title }}</div>
                <div class="gnode-status" :style="{ color: statusColor(data.status) }">{{ statusLabel(data.status) }}</div>
              </div>
            </template>
          </VueFlow>
        </div>

      </div><!-- /content-area -->

      <!-- ── SIDE PANEL ── -->
      <div v-if="showLogPanel" class="side-panel">

        <!-- Pipeline loading state — work started but manifest not yet created -->
        <div v-if="isRunning && !pipelineManifest" class="pipeline-section pipeline-loading">
          <div class="pipeline-header">
            <div class="pipeline-title">
              <span class="pipeline-name">Planning...</span>
            </div>
            <div class="pipeline-status">
              <span class="ps-dot running"></span>
              <span class="ps-text">Running</span>
            </div>
          </div>
          <div class="phase-grid">
            <div v-for="row in Object.keys(PHASES_UI).map(Number).reduce((rows, n, i) => { if (i % 4 === 0) rows.push([]); rows[rows.length-1].push(n); return rows; }, [])" :key="row[0]" class="phase-row">
              <div v-for="n in row" :key="n" class="phase-cell ph-wait">
                <span class="phase-icon">·</span>
                <span class="phase-num">{{ n }}</span>
                <span class="phase-name">{{ PHASES_UI[n].name }}</span>
                <span v-if="PHASES_UI[n].role" class="phase-role" :style="{ color: ROLE_COLORS[PHASES_UI[n].role] }">{{ PHASES_UI[n].role }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Pipeline section (when manifest exists) -->
        <div v-if="pipelineManifest" class="pipeline-section">
          <div class="pipeline-header">
            <div class="pipeline-title">
              <span class="pipeline-name">{{ pipelineManifest.description || 'Pipeline' }}</span>
              <span class="wt-badge" :style="{ color: WORK_TYPE_COLORS[pipelineManifest.work_type], background: WORK_TYPE_COLORS[pipelineManifest.work_type] + '18' }">
                {{ pipelineManifest.work_type }}
              </span>
            </div>
            <div class="pipeline-status">
              <span :class="['ps-dot', pipelineManifest.status]"></span>
              <span class="ps-text">
                {{ pipelineManifest.status === 'failed' ? 'Failed' : pipelineManifest.status === 'completed' ? 'Complete' : `Phase ${pipelineManifest.current_phase}` }}
              </span>
              <button v-if="pipelineManifest.status === 'failed'" class="resume-btn" @click="resumePipeline">↺ Resume</button>
            </div>
          </div>

          <!-- Phase grid 4-per-row -->
          <div class="phase-grid">
            <div v-for="row in phaseRows" :key="row[0].n" class="phase-row">
              <div v-for="p in row" :key="p.n" :class="['phase-cell', phaseClass(p)]" :title="`${p.n}. ${p.name}`">
                <span class="phase-icon">{{ phaseIcon(p) }}</span>
                <span class="phase-num">{{ p.n }}</span>
                <span class="phase-name">{{ p.name }}</span>
                <span v-if="p.role" class="phase-role" :style="{ color: ROLE_COLORS[p.role] }">{{ p.role }}</span>
              </div>
            </div>
          </div>

          <!-- Quality gates -->
          <div class="gates-row">
            <span v-for="g in qualityGates" :key="g.label" :class="['gate', { ok: g.ok }]">
              {{ g.ok ? '✓' : '·' }} {{ g.label }}
            </span>
          </div>
        </div>

        <!-- Logs terminal -->
        <div class="logs-section">
          <div class="logs-header">
            <span>LOGS</span>
            <div class="log-dot" :class="{ active: isRunning }"></div>
          </div>
          <!-- terminal-wrap: no Vue children — xterm owns this DOM entirely -->
          <div ref="logContainerRef" class="terminal-wrap"></div>
          <div v-if="!logs" class="log-empty">WAITING FOR OUTPUT...</div>
        </div>

      </div><!-- /side-panel -->

      <!-- Task detail sidebar -->
      <div v-if="selectedTask && currentView === 'kanban'" class="detail-panel">
        <div class="detail-header">
          <span class="detail-id">{{ selectedTask.id }}</span>
          <button class="icon-btn" @click="selectedTask = null"><XIcon :size="15" /></button>
        </div>
        <div class="detail-body">
          <div class="detail-title">{{ selectedTask.title }}</div>
          <div class="detail-desc" v-if="selectedTask.description">{{ selectedTask.description }}</div>
          <div class="detail-meta">
            <span class="detail-status" :style="{ color: statusColor(selectedTask.status) }">
              {{ statusLabel(selectedTask.status) }}
            </span>
            <span v-if="selectedTask.skill" class="detail-skill">{{ selectedTask.skill }}</span>
          </div>
        </div>
        <div class="detail-actions">
          <button v-if="selectedTask.status === 'pending'" class="btn-primary" @click="startTask(selectedTask.id)" :disabled="isRunning">
            <PlayIcon :size="13" /> Start
          </button>
          <button class="btn-danger" @click="deleteTask(selectedTask.id)">
            <TrashIcon :size="13" /> Delete
          </button>
        </div>
      </div>

    </div><!-- /main-layout -->

    <!-- ══════════════ MODALS ══════════════ -->

    <!-- Work modal -->
    <Teleport to="body">
      <div v-if="showWorkModal" class="overlay" @click.self="showWorkModal = false">
        <div class="modal">
          <div class="modal-head">
            <span>Run Work</span>
            <span v-if="workType" class="wt-badge" :style="{ color: WORK_TYPE_COLORS[workType], background: WORK_TYPE_COLORS[workType] + '18' }">
              {{ workType }}
            </span>
            <button class="icon-btn" @click="showWorkModal = false"><XIcon :size="15" /></button>
          </div>
          <div class="modal-body">
            <textarea v-model="workDesc" class="modal-textarea" rows="3"
              placeholder="Describe the feature... (e.g. add /ping endpoint)"
              autofocus @keydown.ctrl.enter="runWork"></textarea>
            <div class="modal-hint" v-if="workType">
              {{ workType === 'SMALL' || workType === 'BUGFIX' ? 'Work loop only — no quality gates' : workType === 'MEDIUM' ? 'Work loop + reviewer quality pass' : 'Work loop + full quality gates (reviewer, tests, coverage)' }}
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn-ghost" @click="showWorkModal = false">Cancel</button>
            <button class="btn-primary" @click="runWork" :disabled="!workDesc.trim()">
              <PlayIcon :size="13" /> Run
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Plan modal -->
    <Teleport to="body">
      <div v-if="showPlanModal" class="overlay" @click.self="showPlanModal = false">
        <div class="modal">
          <div class="modal-head">
            <span>Plan Feature</span>
            <button class="icon-btn" @click="showPlanModal = false"><XIcon :size="15" /></button>
          </div>
          <div class="modal-body">
            <textarea v-model="planDesc" class="modal-textarea" rows="3"
              placeholder="Describe the feature to plan..."
              autofocus @keydown.ctrl.enter="runPlan"></textarea>
          </div>
          <div class="modal-foot">
            <button class="btn-ghost" @click="showPlanModal = false">Cancel</button>
            <button class="btn-primary" @click="runPlan" :disabled="!planDesc.trim()">
              <FileTextIcon :size="13" /> Plan
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- New task modal -->
    <Teleport to="body">
      <div v-if="showNewTaskForm" class="overlay" @click.self="showNewTaskForm = false">
        <div class="modal">
          <div class="modal-head">
            <span>New Task</span>
            <button class="icon-btn" @click="showNewTaskForm = false"><XIcon :size="15" /></button>
          </div>
          <div class="modal-body">
            <div class="field">
              <label>Title</label>
              <input v-model="newTask.title" placeholder="Task title" autofocus @keydown.enter="addTask" />
            </div>
            <div class="field">
              <label>Description</label>
              <textarea v-model="newTask.description" placeholder="Optional details..." rows="3"></textarea>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn-ghost" @click="showNewTaskForm = false">Cancel</button>
            <button class="btn-primary" @click="addTask" :disabled="!newTask.title.trim()">Create Task</button>
          </div>
        </div>
      </div>
    </Teleport>

  </div><!-- /app -->
</template>

<style>
@import '@vue-flow/core/dist/style.css';
@import '@vue-flow/core/dist/theme-default.css';
@import '@xterm/xterm/css/xterm.css';

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg-base:       #05060a;
  --bg-card:       #0d0e14;
  --bg-card-hover: #12131a;
  --bg-elevated:   #16171f;
  --bg-modal:      #1a1b24;
  --border-subtle: rgba(255,255,255,0.06);
  --border-default:rgba(255,255,255,0.12);
  --text-primary:  #f4f4f5;
  --text-secondary:#9ca3af;
  --text-muted:    #4b5563;
  --accent:        #38bdf8;
  --green:         #10b981;
  --green-muted:   rgba(16,185,129,0.12);
  --blue:          #3b82f6;
  --blue-muted:    rgba(59,130,246,0.12);
  --yellow:        #f59e0b;
  --yellow-muted:  rgba(245,158,11,0.12);
  --red:           #ef4444;
  --red-muted:     rgba(239,68,68,0.12);
  --purple:        #8b5cf6;
  --font-mono:     'JetBrains Mono', 'Fira Code', monospace;
  --radius:        8px;
  --topbar-h:      40px;
}

html, body, #app { height: 100%; overflow: hidden; }
body { background: var(--bg-base); color: var(--text-primary); font-family: system-ui, -apple-system, sans-serif; font-size: 13px; }

/* ── TOPBAR ── */
.app { display: flex; flex-direction: column; height: 100vh; }

.topbar {
  height: var(--topbar-h); flex-shrink: 0;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px; gap: 8px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-subtle);
}
.topbar-left { display: flex; align-items: center; gap: 5px; }
.project-name { font-weight: 600; font-size: 13px; color: var(--text-primary); }
.icon-muted   { color: var(--text-muted); }
.topbar-center { display: flex; align-items: center; gap: 4px; }
.topbar-right  { display: flex; align-items: center; gap: 8px; }

.tab {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 26px; border-radius: 5px;
  border: none; background: transparent; color: var(--text-muted); cursor: pointer;
  transition: all 0.15s;
}
.tab:hover  { background: var(--bg-elevated); color: var(--text-secondary); }
.tab.active { background: var(--bg-elevated); color: var(--text-primary); }

.sep { width: 1px; height: 18px; background: var(--border-subtle); margin: 0 4px; }

.topbar-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 26px; border-radius: 5px;
  border: none; background: transparent; color: var(--text-muted); cursor: pointer;
  transition: all 0.15s;
}
.topbar-btn:hover { background: var(--bg-elevated); color: var(--text-secondary); }

.run-btn, .stop-btn {
  display: flex; align-items: center; gap: 5px;
  padding: 0 12px; height: 26px; border-radius: 5px;
  font-size: 12px; font-weight: 600; cursor: pointer; border: none;
}
.run-btn  { background: var(--green); color: #000; }
.run-btn:hover { background: #0ea271; }
.stop-btn { background: var(--red-muted); color: var(--red); border: 1px solid var(--red-muted); }
.stop-btn:hover { background: rgba(239,68,68,0.2); }

.ctx-badge {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  padding: 2px 7px; border-radius: 4px;
  background: rgba(255,255,255,0.04);
  cursor: default;
}
.ctx-badge.warn   { color: var(--yellow); }
.ctx-badge.danger { color: var(--red); }

.status-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--text-muted);
}
.status-dot.active { background: var(--green); box-shadow: 0 0 6px var(--green); }
.status-text { font-size: 12px; color: var(--text-muted); }

/* ── PROGRESS STRIP ── */
.progress-strip { height: 2px; background: var(--border-subtle); flex-shrink: 0; }
.progress-fill  { height: 100%; background: var(--green); transition: width 0.4s; }

/* ── MAIN LAYOUT ── */
.main-layout {
  flex: 1; display: flex; overflow: hidden;
}

/* ── KANBAN ── */
.content-area { flex: 1; overflow: hidden; display: flex; }

.kanban {
  display: flex; flex: 1; gap: 0; overflow-x: auto; overflow-y: hidden;
}

.kanban-col {
  flex: 1; min-width: 200px; max-width: 320px;
  display: flex; flex-direction: column;
  border-right: 1px solid var(--border-subtle);
}
.kanban-col:last-child { border-right: none; flex: 1; max-width: none; }

.col-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.col-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; color: var(--text-muted); text-transform: uppercase; }
.col-count {
  font-size: 11px; font-weight: 700; min-width: 18px; height: 18px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 4px; background: var(--bg-elevated); color: var(--text-secondary); padding: 0 4px;
}

.col-body {
  flex: 1; overflow-y: auto; padding: 10px 10px 0;
  display: flex; flex-direction: column; gap: 6px;
}
.col-body::-webkit-scrollbar { width: 4px; }
.col-body::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 2px; }

.task-card {
  display: flex; background: var(--bg-card);
  border: 1px solid var(--border-subtle); border-radius: var(--radius);
  cursor: pointer; transition: all 0.12s; overflow: hidden;
  flex-shrink: 0;
}
.task-card:hover     { background: var(--bg-card-hover); border-color: var(--border-default); }
.task-card.selected  { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.task-card.running   { border-color: rgba(59,130,246,0.4); animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{box-shadow:none} 50%{box-shadow:0 0 12px 2px rgba(59,130,246,0.1)} }

.card-bar  { width: 3px; flex-shrink: 0; }
.card-body { flex: 1; padding: 10px 12px; min-width: 0; }
.card-title { font-size: 13px; font-weight: 600; line-height: 1.35; margin-bottom: 3px; color: var(--text-primary); }
.card-desc  {
  font-size: 12px; color: var(--text-secondary); line-height: 1.4; margin-bottom: 6px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.card-footer { display: flex; align-items: center; gap: 8px; }
.card-id     { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); flex: 1; }
.card-status { font-size: 11px; font-weight: 600; }
.card-actions { display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.task-card:hover .card-actions { opacity: 1; }

.card-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 4px; border: none;
  background: var(--bg-elevated); color: var(--text-muted); cursor: pointer; transition: all 0.12s;
}
.card-btn:hover { background: var(--bg-modal); color: var(--text-secondary); }
.card-btn.danger:hover { color: var(--red); }
.card-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.add-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; margin: 2px 0 10px;
  border: 1px dashed var(--border-subtle); border-radius: var(--radius);
  background: transparent; color: var(--text-muted); font-size: 12px;
  cursor: pointer; transition: all 0.12s; width: 100%;
}
.add-btn:hover { border-color: var(--border-default); color: var(--text-secondary); }

/* ── GRAPH ── */
.graph-wrap { flex: 1; overflow: hidden; }

.gnode {
  padding: 12px 16px; background: var(--bg-card);
  border: 1px solid var(--border-subtle); border-radius: var(--radius);
  min-width: 180px; cursor: pointer;
}
.gnode:hover { border-color: var(--border-default); }
.gnode--completed { border-color: rgba(16,185,129,0.3); }
.gnode--in_progress { border-color: rgba(59,130,246,0.4); animation: pulse 2s infinite; }
.gnode--blocked { border-color: rgba(239,68,68,0.3); }
.gnode-id     { font-size: 10px; font-family: var(--font-mono); color: var(--text-muted); margin-bottom: 4px; }
.gnode-title  { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
.gnode-status { font-size: 11px; font-weight: 600; text-transform: capitalize; }

/* ── SIDE PANEL ── */
.side-panel {
  width: 320px; flex-shrink: 0;
  display: flex; flex-direction: column;
  border-left: 1px solid var(--border-subtle);
  overflow: hidden;
}

/* Pipeline section */
.pipeline-section {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-subtle);
  padding: 10px;
}

.pipeline-header { margin-bottom: 8px; }
.pipeline-title  { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.pipeline-name   { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.pipeline-status { display: flex; align-items: center; gap: 6px; }

.wt-badge {
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
  flex-shrink: 0;
}

.ps-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted);
}
.ps-dot.running, .ps-dot.in_progress { background: var(--green); animation: blink 1s infinite; }
.ps-dot.failed   { background: var(--red); }
.ps-dot.completed { background: var(--green); }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }

.ps-text    { font-size: 11px; color: var(--text-secondary); }
.resume-btn { font-size: 11px; color: var(--yellow); background: none; border: none; cursor: pointer; padding: 0; }
.resume-btn:hover { text-decoration: underline; }

/* Phase grid */
.phase-grid { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.phase-row  { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; }

.phase-cell {
  display: flex; flex-direction: column; align-items: center;
  padding: 4px 2px; border-radius: 4px;
  background: var(--bg-elevated); border: 1px solid transparent;
  min-width: 0; text-align: center;
}
.phase-cell.ph-done { background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.2); }
.phase-cell.ph-run  { background: rgba(56,189,248,0.08); border-color: rgba(56,189,248,0.3); animation: blink 1s infinite; }
.phase-cell.ph-fail { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.2); }
.phase-cell.ph-skip { opacity: 0.3; }
.phase-cell.ph-wait { opacity: 0.6; }

.phase-icon { font-size: 11px; line-height: 1; margin-bottom: 1px; }
.phase-cell.ph-done .phase-icon { color: var(--green); }
.phase-cell.ph-run  .phase-icon { color: var(--accent); }
.phase-cell.ph-fail .phase-icon { color: var(--red); }
.phase-num  { font-size: 9px; color: var(--text-muted); font-family: var(--font-mono); }
.phase-name { font-size: 9px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; max-width: 100%; text-overflow: ellipsis; }
.phase-role { font-size: 8px; font-weight: 600; margin-top: 1px; }

/* Quality gates */
.gates-row  { display: flex; gap: 8px; }
.gate { font-size: 11px; color: var(--text-muted); }
.gate.ok { color: var(--green); }

/* Logs section */
.logs-section { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.logs-header  {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; flex-shrink: 0;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: var(--text-muted); text-transform: uppercase;
}
.log-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); }
.log-dot.active { background: var(--green); animation: blink 1s infinite; }

.terminal-wrap {
  flex: 1; overflow: hidden; padding: 4px;
  position: relative; min-height: 0;
}
.terminal-wrap .xterm { height: 100%; }
.terminal-wrap .xterm-screen { height: 100% !important; }
.terminal-wrap .xterm-viewport { border-radius: 4px; }
.log-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);
  white-space: nowrap;
}

/* ── DETAIL PANEL ── */
.detail-panel {
  width: 260px; flex-shrink: 0;
  border-left: 1px solid var(--border-subtle);
  display: flex; flex-direction: column;
  background: var(--bg-card);
}
.detail-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;
}
.detail-id { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); }
.detail-body { flex: 1; padding: 14px 12px; overflow-y: auto; }
.detail-title { font-size: 14px; font-weight: 600; color: var(--text-primary); line-height: 1.4; margin-bottom: 8px; }
.detail-desc  { font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px; }
.detail-meta  { display: flex; gap: 8px; align-items: center; }
.detail-status { font-size: 11px; font-weight: 600; }
.detail-skill  { font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(139,92,246,0.12); color: var(--purple); }
.detail-actions { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--border-subtle); flex-shrink: 0; }

/* ── BUTTONS ── */
.btn-primary, .btn-ghost, .btn-danger {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 14px; border-radius: 6px;
  font-size: 12px; font-weight: 600; cursor: pointer; border: none;
  transition: all 0.15s;
}
.btn-primary { background: var(--green); color: #000; }
.btn-primary:hover { background: #0ea271; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost   { background: var(--bg-elevated); color: var(--text-secondary); }
.btn-ghost:hover { background: var(--bg-modal); }
.btn-danger  { background: var(--red-muted); color: var(--red); }
.btn-danger:hover { background: rgba(239,68,68,0.2); }

.icon-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 5px;
  border: none; background: transparent; color: var(--text-muted); cursor: pointer;
}
.icon-btn:hover { background: var(--bg-elevated); color: var(--text-secondary); }

/* ── MODALS ── */
.overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: var(--bg-modal); border: 1px solid var(--border-default);
  border-radius: 10px; width: 440px; max-width: 90vw;
  box-shadow: 0 24px 48px rgba(0,0,0,0.5);
}
.modal-head {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 16px; border-bottom: 1px solid var(--border-subtle);
  font-weight: 600; font-size: 14px;
}
.modal-head > span:first-child { flex: 1; }
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--border-subtle);
}
.modal-textarea {
  width: 100%; resize: vertical; background: var(--bg-elevated);
  border: 1px solid var(--border-default); border-radius: 6px;
  color: var(--text-primary); font-size: 13px; padding: 10px 12px;
  font-family: inherit; outline: none; transition: border-color 0.15s;
}
.modal-textarea:focus { border-color: var(--accent); }
.modal-hint { font-size: 11px; color: var(--text-muted); }

.field { display: flex; flex-direction: column; gap: 5px; }
.field label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.field input, .field textarea {
  background: var(--bg-elevated); border: 1px solid var(--border-default);
  border-radius: 6px; color: var(--text-primary); font-size: 13px; padding: 8px 10px;
  font-family: inherit; outline: none; width: 100%; resize: vertical;
}
.field input:focus, .field textarea:focus { border-color: var(--accent); }

/* Vue Flow overrides */
.vue-flow { background: var(--bg-base) !important; }
.vue-flow__controls { background: var(--bg-card) !important; border: 1px solid var(--border-subtle) !important; }
.vue-flow__controls button { background: transparent !important; color: var(--text-muted) !important; border: none !important; }
.vue-flow__controls button:hover { background: var(--bg-elevated) !important; color: var(--text-primary) !important; }
.vue-flow__minimap { background: var(--bg-card) !important; border: 1px solid var(--border-subtle) !important; }
</style>
