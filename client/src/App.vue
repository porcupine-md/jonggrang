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
  ChevronDownIcon, SettingsIcon, FileTextIcon,
  SearchIcon, ZapIcon, EyeIcon, ArrowRightIcon,
  ClockIcon, Loader2Icon, BookOpenIcon,
} from 'lucide-vue-next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const socket = io({ transports: ['websocket'] });

// ============================================================
// STATE
// ============================================================
const isJonggrangRunning = ref(false);
const logs = ref('');
const rawTasks = ref([]);
const featureName = ref('');
const branchName = ref('');
const projectConfig = ref(null);

// UI state
const currentView = ref('kanban'); // 'kanban' | 'graph'
const selectedTask = ref(null);
const showNewTaskForm = ref(false);
const showPlanModal = ref(false);
const showLogPanel = ref(true);
const planDescription = ref('');
const newTask = ref({ title: '', description: '', priority: 1 });

// ============================================================
// COMPUTED
// ============================================================
const projectName = computed(() => projectConfig.value?.name || 'Jonggrang');

const columns = computed(() => {
  const cols = [
    { key: 'pending', label: 'TODO', color: 'var(--text-muted)' },
    { key: 'in_progress', label: 'IN PROGRESS', color: 'var(--blue)' },
    { key: 'blocked', label: 'BLOCKED', color: 'var(--red)' },
    { key: 'completed', label: 'DONE', color: 'var(--green)' },
  ];
  return cols.map(col => ({
    ...col,
    tasks: rawTasks.value.filter(t => t.status === col.key),
    count: rawTasks.value.filter(t => t.status === col.key).length,
  }));
});

const totalTasks = computed(() => rawTasks.value.length);
const completedTasks = computed(() => rawTasks.value.filter(t => t.status === 'completed').length);
const progressPercent = computed(() => totalTasks.value === 0 ? 0 : Math.round((completedTasks.value / totalTasks.value) * 100));

// ============================================================
// GRAPH VIEW
// ============================================================
const graphNodes = computed(() => {
  const tasks = rawTasks.value;
  const nodes = [];
  const edges = [];
  const levelMap = new Map();
  const nodeLevels = new Map();

  const roots = tasks.filter(t => !t.blocked_by || t.blocked_by.length === 0);

  function assignLevel(taskId, level) {
    const current = nodeLevels.get(taskId);
    if (current === undefined || current < level) {
      nodeLevels.set(taskId, level);
      const children = tasks.filter(t => t.blocked_by && t.blocked_by.includes(taskId));
      children.forEach(c => assignLevel(c.id, level + 1));
    }
  }
  roots.forEach(r => assignLevel(r.id, 0));

  // Vertical layout: y = level (row), x = staggered per row
  tasks.forEach(task => {
    const level = nodeLevels.get(task.id) ?? 0;
    const sameLevelNodes = levelMap.get(level) || [];
    const col = sameLevelNodes.length;
    // Stagger: odd rows offset right, multiple nodes spread horizontally
    const baseX = col * 260;
    const offset = (level % 2 === 1) ? 100 : 0;
    const x = baseX + offset + 60;
    const y = level * 140 + 60;
    levelMap.set(level, [...sameLevelNodes, task]);

    nodes.push({
      id: task.id,
      position: { x, y },
      data: { ...task },
      type: 'taskNode',
    });

    if (task.blocked_by) {
      task.blocked_by.forEach(blocker => {
        edges.push({
          id: `e-${blocker}-${task.id}`,
          source: blocker,
          target: task.id,
          animated: task.status === 'in_progress',
          style: {
            stroke: task.status === 'completed' ? 'var(--green)' : 'rgba(255,255,255,0.12)',
            strokeWidth: 2,
          },
        });
      });
    }
  });

  return { nodes, edges };
});

// ============================================================
// SOCKET EVENTS
// ============================================================
onMounted(() => {
  socket.on('jonggrang_status', (data) => { isJonggrangRunning.value = data.isRunning; });

  socket.on('tasks_update', (data) => {
    if (data && data.tasks) {
      rawTasks.value = data.tasks;
      featureName.value = data.feature || '';
      branchName.value = data.branch || '';
    }
  });

  socket.on('config_update', (data) => {
    if (data) projectConfig.value = data;
  });

  socket.on('progress_update', () => {
    // progress.txt updates are tracked via file watcher; do not overwrite live logs
  });

socket.on('log', (data) => {
  logs.value += data;
});
});

const sidebarTerminalEl = ref(null);
const logTerminalEl = ref(null);
const activeTerminalEl = computed(() => sidebarTerminalEl.value || logTerminalEl.value);
const terminalInstance = shallowRef(null);
const fitAddon = shallowRef(null);
const logContentLength = ref(0);
let resizeHandler = null;
let resizeObserver = null;

function renderFullLog() {
  if (!terminalInstance.value) return;
  terminalInstance.value.clear();
  if (logs.value) {
    terminalInstance.value.write(logs.value.replace(/\r?\n/g, '\r\n'));
    logContentLength.value = logs.value.length;
    terminalInstance.value.scrollToBottom();
  } else {
    logContentLength.value = 0;
  }
}

function attachTerminal(container) {
  if (!terminalInstance.value || !container) return;
  const term = terminalInstance.value;

  if (term.element) {
    container.innerHTML = '';
    container.appendChild(term.element);
  } else {
    container.innerHTML = '';
    term.open(container);
  }

  // Delay fit until layout has settled so xterm measures the correct width
  requestAnimationFrame(() => {
    fitAddon.value?.fit();
    logContentLength.value = 0;
    renderFullLog();
  });

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => fitAddon.value?.fit());
  });
  resizeObserver.observe(container);
}

onMounted(() => {
  const term = new Terminal({
    convertEol: true,
    scrollback: 5000,
    fontSize: 12,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    theme: {
      background: '#05060a',
      foreground: '#f4f4f5',
      cursor: '#38bdf8',
      cursorAccent: '#05060a',
      selectionBackground: 'rgba(56,189,248,0.25)',
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  terminalInstance.value = term;
  fitAddon.value = fit;

  resizeHandler = () => {
    if (!activeTerminalEl.value) return;
    requestAnimationFrame(() => fitAddon.value?.fit());
  };
  window.addEventListener('resize', resizeHandler);

  nextTick(() => {
    if (activeTerminalEl.value) {
      attachTerminal(activeTerminalEl.value);
    }
  });
});

watch(activeTerminalEl, (container) => {
  if (!container || !terminalInstance.value) return;
  nextTick(() => attachTerminal(container));
}, { flush: 'post' });

watch(logs, (newVal) => {
  if (!terminalInstance.value) return;
  const term = terminalInstance.value;
  const activeContainer = activeTerminalEl.value;
  if (!activeContainer) return;

  // Re-attach terminal if it's not mounted in the active container
  if (!term.element || !activeContainer.contains(term.element)) {
    attachTerminal(activeContainer);
    return;
  }

  if (!newVal) {
    renderFullLog();
    return;
  }

  if (newVal.length < logContentLength.value) {
    renderFullLog();
    return;
  }

  const diff = newVal.slice(logContentLength.value);
  if (diff) {
    term.write(diff.replace(/\r?\n/g, '\r\n'));
    logContentLength.value = newVal.length;
    term.scrollToBottom();
  }
}, { flush: 'post' });

onBeforeUnmount(() => {
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
  }
  resizeObserver?.disconnect();
  terminalInstance.value?.dispose();
  terminalInstance.value = null;
  fitAddon.value = null;
});

// ============================================================
// ACTIONS
// ============================================================
async function apiPost(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function startJonggrang(taskId) {
  logs.value = '';
  logContentLength.value = 0;
  if (terminalInstance.value) terminalInstance.value.clear();
  const tool = projectConfig.value?.tool || 'opencode';
  await apiPost('/api/jonggrang/start', { taskId, tool });
}

async function stopJonggrang() {
  await apiPost('/api/jonggrang/stop');
}

async function startPlan() {
  if (!planDescription.value.trim()) return;
  logs.value = '';
  logContentLength.value = 0;
  if (terminalInstance.value) terminalInstance.value.clear();
  await apiPost('/api/jonggrang/plan', { description: planDescription.value });
  showPlanModal.value = false;
  planDescription.value = '';
}

async function startReview() {
  logs.value = '';
  logContentLength.value = 0;
  if (terminalInstance.value) terminalInstance.value.clear();
  await apiPost('/api/jonggrang/review');
}

async function addTask() {
  if (!newTask.value.title.trim()) return;
  await apiPost('/api/jonggrang/tasks', newTask.value);
  newTask.value = { title: '', description: '', priority: 1 };
  showNewTaskForm.value = false;
}

async function deleteTask(taskId) {
  await fetch(`/api/jonggrang/tasks/${taskId}`, { method: 'DELETE' });
  if (selectedTask.value?.id === taskId) selectedTask.value = null;
}

async function updateStatus(taskId, status) {
  await fetch(`/api/jonggrang/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

function selectTask(task) {
  selectedTask.value = selectedTask.value?.id === task.id ? null : task;
}

function parsedDescription(desc) {
  if (!desc) return { summary: '', criteria: [] };
  // Split on "Acceptance criteria:" or similar patterns
  const match = desc.match(/^(.*?)\s*[Aa]cceptance\s+criteria\s*:\s*(.*)$/s);
  if (!match) return { summary: desc, criteria: [] };
  const summary = match[1].replace(/\.\s*$/, '').trim();
  // Split criteria on semicolons or sentence boundaries
  const raw = match[2].trim().replace(/\.\s*$/, '');
  const criteria = raw.split(/;\s*/).map(s => s.trim()).filter(Boolean);
  return { summary, criteria };
}

function statusIcon(status) {
  switch (status) {
    case 'completed': return CheckCircle2Icon;
    case 'in_progress': return Loader2Icon;
    case 'blocked': return CircleAlertIcon;
    default: return CircleIcon;
  }
}

function statusColor(status) {
  switch (status) {
    case 'completed': return 'var(--green)';
    case 'in_progress': return 'var(--blue)';
    case 'blocked': return 'var(--red)';
    default: return 'var(--text-muted)';
  }
}

// Drag and drop
let draggedTask = null;
function onDragStart(e, task) {
  draggedTask = task;
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function onDrop(e, columnKey) {
  e.preventDefault();
  if (draggedTask && draggedTask.status !== columnKey) {
    updateStatus(draggedTask.id, columnKey);
  }
  draggedTask = null;
}
</script>

<template>
  <div class="app">
    <!-- ==================== TOP BAR ==================== -->
    <header class="topbar">
      <div class="topbar-left">
        <div class="project-selector">
          <span class="project-name">{{ projectName }}</span>
          <ChevronDownIcon :size="14" class="icon-muted" />
        </div>
      </div>

      <div class="topbar-center">
        <div class="view-tabs">
          <button :class="['tab', { active: currentView === 'kanban' }]" @click="currentView = 'kanban'">
            <LayoutGridIcon :size="15" />
          </button>
          <button :class="['tab', { active: currentView === 'graph' }]" @click="currentView = 'graph'">
            <GitBranchIcon :size="15" />
          </button>
        </div>
        <div class="separator"></div>
        <button class="topbar-btn" @click="showPlanModal = true" title="Plan feature">
          <FileTextIcon :size="15" />
        </button>
        <button class="topbar-btn" @click="startReview" title="Run review">
          <EyeIcon :size="15" />
        </button>
        <div class="separator"></div>

        <button
          v-if="!isJonggrangRunning"
          class="run-btn"
          @click="startJonggrang()"
        >
          <PlayIcon :size="13" />
          <span>Run</span>
          <span class="run-branch" v-if="branchName">{{ branchName }}</span>
        </button>
        <button
          v-else
          class="stop-btn"
          @click="stopJonggrang"
        >
          <SquareIcon :size="12" />
          <span>Stop</span>
        </button>
      </div>

      <div class="topbar-right">
        <button class="topbar-btn" @click="showLogPanel = !showLogPanel" :class="{ active: showLogPanel }" title="Toggle logs">
          <BookOpenIcon :size="15" />
        </button>
        <div class="status-badge" :class="{ running: isJonggrangRunning }">
          <ZapIcon :size="13" />
          <span>{{ isJonggrangRunning ? 'Running' : 'Idle' }}</span>
        </div>
      </div>
    </header>

    <!-- ==================== PROGRESS BAR ==================== -->
    <div class="progress-strip" v-if="totalTasks > 0">
      <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
    </div>

    <!-- ==================== MAIN CONTENT ==================== -->
    <div class="main-layout">
      <!-- KANBAN VIEW -->
      <div v-if="currentView === 'kanban'" class="kanban-wrapper">
        <div class="kanban">
          <div
            v-for="col in columns"
            :key="col.key"
            class="kanban-column"
            @dragover="onDragOver"
            @drop="(e) => onDrop(e, col.key)"
          >
            <!-- Column Header -->
            <div class="col-header">
              <div class="col-title">
                <span class="col-label">{{ col.label }}</span>
                <span class="col-count" :style="{ background: col.count > 0 ? statusColor(col.key) : 'var(--bg-card)', color: col.count > 0 ? 'var(--bg-base)' : 'var(--text-muted)' }">{{ col.count }}</span>
              </div>
            </div>

            <!-- Cards -->
            <div class="col-scroll-area">
              <div class="col-cards">
                <div
                  v-for="task in col.tasks"
                  :key="task.id"
                  :class="['task-card', { selected: selectedTask?.id === task.id, 'is-running': task.status === 'in_progress' && isJonggrangRunning }]"
                  draggable="true"
                  @dragstart="(e) => onDragStart(e, task)"
                  @click="selectTask(task)"
                >
                  <div class="card-indicator" :style="{ background: statusColor(task.status) }"></div>
                  <div class="card-body">
                    <h4 class="card-title">{{ task.title }}</h4>
                    <p class="card-desc" v-if="task.description && task.description !== task.title">{{ task.description }}</p>
                    <div class="card-meta">
                      <span class="card-id">{{ task.id }}</span>
                      <span class="card-skill" v-if="task.skill">{{ task.skill }}</span>
                    </div>
                    <div class="card-actions">
                      <span class="card-status-tag" :style="{ color: statusColor(task.status), background: task.status === 'completed' ? 'var(--green-muted)' : task.status === 'in_progress' ? 'var(--blue-muted)' : task.status === 'blocked' ? 'var(--red-muted)' : 'rgba(255,255,255,0.05)' }">
                        {{ task.status === 'in_progress' ? 'In Progress' : task.status === 'pending' ? 'Ready' : task.status.charAt(0).toUpperCase() + task.status.slice(1) }}
                      </span>
                      <div class="card-btns">
                        <button
                          v-if="task.status === 'pending'"
                          class="card-btn start-btn"
                          @click.stop="startJonggrang(task.id)"
                          :disabled="isJonggrangRunning"
                          title="Start this task"
                        >
                          <PlayIcon :size="12" />
                          Start
                        </button>
                        <button
                          v-if="task.status !== 'completed'"
                          class="card-btn delete-btn"
                          @click.stop="deleteTask(task.id)"
                          title="Delete task"
                        >
                          <XIcon :size="12" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Add task button (only in TODO column) -->
                <button
                  v-if="col.key === 'pending'"
                  class="add-task-btn"
                  @click="showNewTaskForm = !showNewTaskForm"
                >
                  <PlusIcon :size="15" />
                  <span>New task</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- New Task Form (inline at bottom of TODO) -->
        <Teleport to="body">
          <div v-if="showNewTaskForm" class="modal-overlay" @click.self="showNewTaskForm = false">
            <div class="modal">
              <div class="modal-header">
                <h3>New Task</h3>
                <button class="modal-close" @click="showNewTaskForm = false"><XIcon :size="16" /></button>
              </div>
              <div class="modal-body">
                <div class="form-field">
                  <label>Title</label>
                  <input v-model="newTask.title" placeholder="Task title" autofocus @keydown.enter="addTask" />
                </div>
                <div class="form-field">
                  <label>Description</label>
                  <textarea v-model="newTask.description" placeholder="Detailed description..." rows="3"></textarea>
                </div>
                <div class="form-field">
                  <label>Priority</label>
                  <input v-model.number="newTask.priority" type="number" min="1" />
                </div>
              </div>
              <div class="modal-footer">
                <button class="btn btn-ghost" @click="showNewTaskForm = false">Cancel</button>
                <button class="btn btn-primary" @click="addTask">Create Task</button>
              </div>
            </div>
          </div>
        </Teleport>
      </div>

      <!-- GRAPH VIEW -->
      <div v-else class="graph-wrapper">
        <VueFlow
          :nodes="graphNodes.nodes"
          :edges="graphNodes.edges"
          :default-viewport="{ zoom: 0.85, x: 0, y: 0 }"
          fit-view-on-init
        >
          <Background :gap="24" :size="1" pattern-color="rgba(255,255,255,0.03)" />
          <Controls position="bottom-left" />
          <MiniMap position="bottom-right" />

          <template #node-taskNode="{ data }">
            <div :class="['graph-node', `graph-node--${data.status}`]" @click="selectTask(data)">
              <div class="graph-node-header">
                <component :is="statusIcon(data.status)" :size="14" :style="{ color: statusColor(data.status) }" />
                <span class="graph-node-id">{{ data.id }}</span>
              </div>
              <div class="graph-node-title">{{ data.title }}</div>
              <div class="graph-node-status" :style="{ color: statusColor(data.status) }">
                {{ data.status.replace('_', ' ') }}
              </div>
            </div>
          </template>
        </VueFlow>
      </div>

      <!-- ==================== SIDE PANELS ==================== -->
      <aside v-if="selectedTask || showLogPanel" class="right-sidebar">
        <section v-if="selectedTask" class="detail-panel">
          <div class="detail-status-bar" :style="{ background: statusColor(selectedTask.status) }"></div>
          <div class="detail-header">
            <div class="detail-status-badge" :style="{ color: statusColor(selectedTask.status) }">
              <component :is="statusIcon(selectedTask.status)" :size="14" />
              {{ selectedTask.status.replace('_', ' ').toUpperCase() }}
            </div>
            <button class="modal-close" @click="selectedTask = null"><XIcon :size="16" /></button>
          </div>

          <div class="detail-scroll">
            <h2 class="detail-title">{{ selectedTask.title }}</h2>
            <div class="detail-desc">
              <p class="detail-summary">{{ parsedDescription(selectedTask.description).summary }}</p>
              <ul v-if="parsedDescription(selectedTask.description).criteria.length" class="detail-criteria">
                <li v-for="(c, i) in parsedDescription(selectedTask.description).criteria" :key="i">{{ c }}</li>
              </ul>
            </div>

            <div class="detail-fields">
              <div class="detail-field" v-if="selectedTask.skill">
                <div class="detail-field-label"><ZapIcon :size="12" /> Skill</div>
                <div class="detail-field-value">{{ selectedTask.skill }}</div>
              </div>
              <div class="detail-field" v-if="branchName">
                <div class="detail-field-label"><GitBranchIcon :size="12" /> Branch</div>
                <div class="detail-field-value mono">{{ branchName }}</div>
              </div>
              <div class="detail-field" v-if="selectedTask.files && selectedTask.files.length">
                <div class="detail-field-label"><FileTextIcon :size="12" /> Files</div>
                <ul class="detail-file-list">
                  <li v-for="f in selectedTask.files" :key="f">{{ f }}</li>
                </ul>
              </div>
              <div class="detail-field" v-if="selectedTask.blocked_by && selectedTask.blocked_by.length">
                <div class="detail-field-label"><ClockIcon :size="12" /> Blocked by</div>
                <div class="detail-tags">
                  <span class="detail-tag" v-for="b in selectedTask.blocked_by" :key="b">{{ b }}</span>
                </div>
              </div>
              <div class="detail-field" v-if="selectedTask.notes && selectedTask.notes.length">
                <div class="detail-field-label"><SearchIcon :size="12" /> Notes</div>
                <ul class="detail-notes-list">
                  <li v-for="(n, i) in selectedTask.notes" :key="i">{{ n }}</li>
                </ul>
              </div>
              <div class="detail-field" v-if="selectedTask.completed_at">
                <div class="detail-field-label"><CheckCircle2Icon :size="12" /> Completed</div>
                <div class="detail-field-value">{{ new Date(selectedTask.completed_at).toLocaleString() }}</div>
              </div>
            </div>
          </div>

          <div class="detail-output">
            <div class="detail-output-header">
              <BookOpenIcon :size="13" />
              <span>Agent Output</span>
              <div class="log-indicator" :class="{ active: isJonggrangRunning }"></div>
            </div>
            <div class="detail-output-content">
              <div ref="sidebarTerminalEl" class="xterm-container"></div>
              <div v-if="!logs" class="xterm-empty">Waiting for output...</div>
            </div>
          </div>

          <div class="detail-actions">
            <button
              v-if="selectedTask.status === 'pending'"
              class="btn btn-primary"
              @click="startJonggrang(selectedTask.id)"
              :disabled="isJonggrangRunning"
            >
              <PlayIcon :size="14" />
              Start Task
            </button>
            <button
              v-if="selectedTask.status === 'pending'"
              class="btn btn-ghost"
              @click="updateStatus(selectedTask.id, 'completed')"
            >
              <CheckCircle2Icon :size="14" />
              Mark Done
            </button>
            <button
              v-if="selectedTask.status === 'blocked'"
              class="btn btn-ghost"
              @click="updateStatus(selectedTask.id, 'pending')"
            >
              Unblock
            </button>
            <button
              v-if="selectedTask.status !== 'completed'"
              class="btn btn-danger"
              @click="deleteTask(selectedTask.id); selectedTask = null"
            >
              <TrashIcon :size="14" />
              Delete
            </button>
          </div>
        </section>

        <section v-else class="log-panel">
          <div class="log-header">
            <h3>
              <BookOpenIcon :size="14" />
              Logs
            </h3>
            <div class="log-indicator" :class="{ active: isJonggrangRunning }"></div>
          </div>
          <div class="log-content">
            <div ref="logTerminalEl" class="xterm-container"></div>
            <div v-if="!logs" class="xterm-empty">Waiting for output...</div>
          </div>
        </section>
      </aside>
    </div>

    <!-- ==================== PLAN MODAL ==================== -->
    <Teleport to="body">
      <div v-if="showPlanModal" class="modal-overlay" @click.self="showPlanModal = false">
        <div class="modal modal-wide">
          <div class="modal-header">
            <h3>Plan Feature</h3>
            <button class="modal-close" @click="showPlanModal = false"><XIcon :size="16" /></button>
          </div>
          <div class="modal-body">
            <div class="form-field">
              <label>Feature Description</label>
              <textarea
                v-model="planDescription"
                placeholder="Describe the feature you want to build..."
                rows="5"
                autofocus
              ></textarea>
            </div>
            <p class="form-hint">Jonggrang will decompose this into atomic tasks using AI.</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" @click="showPlanModal = false">Cancel</button>
            <button class="btn btn-primary" @click="startPlan" :disabled="!planDescription.trim()">
              <ZapIcon :size="14" />
              Generate Plan
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ==================== TOP BAR ==================== */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 46px;
  padding: 0 14px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  -webkit-app-region: drag;
  user-select: none;
}

.topbar-left, .topbar-right, .topbar-center {
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar-left { min-width: 180px; }
.topbar-right { min-width: 180px; justify-content: flex-end; }

.project-selector {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.project-selector:hover { background: rgba(255,255,255,0.05); }
.project-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.icon-muted { color: var(--text-muted); }

.view-tabs {
  display: flex;
  background: var(--bg-base);
  border-radius: var(--radius-sm);
  padding: 2px;
}
.tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 28px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.15s;
}
.tab:hover { color: var(--text-secondary); }
.tab.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}

.separator {
  width: 1px;
  height: 20px;
  background: var(--border-default);
}

.topbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 28px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.15s;
}
.topbar-btn:hover { color: var(--text-primary); background: rgba(255,255,255,0.06); }
.topbar-btn.active { color: var(--accent); }

.run-btn, .stop-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  -webkit-app-region: no-drag;
}

.run-btn {
  background: var(--green-muted);
  color: var(--green-text);
  border-color: rgba(16, 185, 129, 0.3);
}
.run-btn:hover {
  background: rgba(16, 185, 129, 0.25);
  border-color: var(--green);
}
.run-branch {
  font-size: 11px;
  font-family: var(--font-mono);
  opacity: 0.7;
  padding-left: 4px;
  border-left: 1px solid rgba(16, 185, 129, 0.3);
  margin-left: 2px;
  padding-left: 6px;
}

.stop-btn {
  background: var(--red-muted);
  color: var(--red-text);
  border-color: rgba(239, 68, 68, 0.3);
}
.stop-btn:hover {
  background: rgba(239, 68, 68, 0.25);
  border-color: var(--red);
}

.status-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 10px;
  border-radius: 99px;
  background: rgba(255,255,255,0.04);
}
.status-badge.running {
  color: var(--green-text);
  background: var(--green-muted);
  animation: pulse-glow 2s ease-in-out infinite;
}
@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
  50% { box-shadow: 0 0 8px 2px rgba(16, 185, 129, 0.15); }
}

/* ==================== PROGRESS STRIP ==================== */
.progress-strip {
  height: 2px;
  background: var(--bg-base);
  flex-shrink: 0;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--green));
  transition: width 0.5s ease;
}

/* ==================== MAIN LAYOUT ==================== */
.main-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

/* ==================== KANBAN ==================== */
.kanban-wrapper {
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 0;
  -webkit-overflow-scrolling: touch;
}

.kanban {
  display: flex;
  height: 100%;
  min-height: 0;
  padding: 0;
  gap: 0;
  align-items: stretch;
}

.kanban-column {
  min-width: 300px;
  max-width: 340px;
  flex: 1;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-base);
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.kanban-column:last-child { border-right: none; }

.col-header {
  padding: 16px 16px 12px;
  flex-shrink: 0;
}
.col-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.col-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-muted);
}
.col-count {
  font-size: 11px;
  font-weight: 700;
  min-width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  padding: 0 5px;
}

.col-scroll-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.col-cards {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ==================== TASK CARD ==================== */
.task-card {
  display: flex;
  flex-shrink: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s;
  overflow: hidden;
}
.task-card:hover {
  background: var(--bg-card-hover);
  border-color: var(--border-default);
  box-shadow: var(--shadow-card);
}
.task-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), var(--shadow-card);
}
.task-card.is-running {
  border-color: rgba(59, 130, 246, 0.4);
  animation: running-pulse 2s ease-in-out infinite;
}
@keyframes running-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
  50% { box-shadow: 0 0 12px 2px rgba(59, 130, 246, 0.1); }
}

.card-indicator {
  width: 3px;
  flex-shrink: 0;
}
.card-body {
  flex: 1;
  padding: 12px 14px;
  min-width: 0;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
  margin-bottom: 4px;
}
.card-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.45;
  margin-bottom: 8px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.card-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.card-skill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--purple-muted);
  color: var(--purple);
  font-weight: 500;
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-status-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}
.card-btns {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.task-card:hover .card-btns { opacity: 1; }

.card-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-default);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.card-btn:hover { color: var(--text-primary); background: var(--bg-card-hover); }
.start-btn {
  color: var(--green-text);
  border-color: rgba(16, 185, 129, 0.3);
  background: var(--green-muted);
}
.start-btn:hover { border-color: var(--green); }
.start-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.delete-btn:hover { color: var(--red-text); border-color: rgba(239, 68, 68, 0.4); }

.add-task-btn {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px dashed var(--border-default);
  background: none;
  color: var(--text-muted);
  border-radius: var(--radius-md);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  width: 100%;
  justify-content: center;
}
.add-task-btn:hover {
  color: var(--text-secondary);
  border-color: var(--border-strong);
  background: rgba(255,255,255,0.02);
}

/* ==================== GRAPH VIEW ==================== */
.graph-wrapper {
  flex: 1;
  background: radial-gradient(circle at 50% 50%, rgba(30, 33, 40, 0.3) 0%, var(--bg-base) 100%);
}

.graph-node {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  min-width: 200px;
  max-width: 240px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: all 0.15s;
}
.graph-node:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-elevated);
  border-color: var(--border-strong);
}
.graph-node--completed { border-color: rgba(16, 185, 129, 0.3); }
.graph-node--in_progress { border-color: rgba(59, 130, 246, 0.4); }
.graph-node--blocked { border-color: rgba(239, 68, 68, 0.3); }

.graph-node-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.graph-node-id {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.graph-node-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  margin-bottom: 6px;
}
.graph-node-status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* ==================== SIDE BAR ==================== */
.right-sidebar {
  width: 380px;
  min-width: 320px;
  max-width: 44vw;
  flex-shrink: 0;
  border-left: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.detail-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail-status-bar { height: 3px; }
.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 0;
  flex-shrink: 0;
}
.detail-status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.detail-scroll {
  overflow-y: auto;
  flex-shrink: 1;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.1) transparent;
}

.detail-title {
  font-size: 16px;
  font-weight: 600;
  padding: 10px 16px 6px;
  color: var(--text-primary);
  line-height: 1.35;
}
.detail-desc {
  padding: 0 16px 12px;
}
.detail-summary {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin: 0 0 8px;
}
.detail-criteria {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-criteria li {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
  padding: 5px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 4px;
  border-left: 2px solid rgba(56, 189, 248, 0.3);
  word-break: break-word;
}
.detail-fields {
  border-top: 1px solid var(--border-subtle);
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.detail-field-label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}
.detail-field-value {
  color: var(--text-primary);
  font-size: 12px;
  word-break: break-word;
}
.detail-file-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.detail-file-list li {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  padding: 3px 8px;
  background: rgba(255,255,255,0.04);
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
  word-break: break-all;
}
.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.detail-tag {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-primary);
  padding: 2px 8px;
  background: rgba(255,255,255,0.04);
  border-radius: 4px;
  border: 1px solid var(--border-subtle);
}
.detail-notes-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.detail-notes-list li {
  font-size: 11px;
  color: var(--text-secondary);
  padding: 6px 8px;
  background: rgba(255,255,255,0.03);
  border-radius: 4px;
  border-left: 2px solid var(--border-subtle);
  line-height: 1.5;
  word-break: break-word;
}
.mono { font-family: var(--font-mono); font-size: 12px; }

.detail-output {
  border-top: 1px solid var(--border-subtle);
  flex: 1;
  min-height: 160px;
  display: flex;
  flex-direction: column;
}
.detail-output-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-size: 11px;
  font-weight: 600;
}
.detail-output-header .log-indicator {
  margin-left: auto;
}
.detail-output-content {
  flex: 1;
  min-height: 0;
  position: relative;
  padding: 0;
  display: flex;
}

.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle);
}

/* ==================== LOG PANEL ==================== */
.log-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.log-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}
.log-header h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.log-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
}
.log-indicator.active {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
  animation: log-pulse 1.5s ease-in-out infinite;
}
@keyframes log-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.log-content {
  flex: 1;
  min-height: 0;
  position: relative;
  padding: 0;
  display: flex;
}

.xterm-container {
  width: 100%;
  height: 100%;
  padding: 4px;
  box-sizing: border-box;
  background: rgba(5, 6, 10, 0.85);
  border-radius: var(--radius-md);
  border: 1px solid rgba(148, 163, 184, 0.2);
  overflow: hidden;
}

:deep(.xterm) {
  font-family: var(--font-mono);
  font-size: 12px;
}

:deep(.xterm .xterm-viewport) {
  scrollbar-width: thin;
  scrollbar-color: rgba(56, 189, 248, 0.35) transparent;
}

:deep(.xterm-viewport::-webkit-scrollbar) {
  width: 6px;
  height: 6px;
}

:deep(.xterm-viewport::-webkit-scrollbar-thumb) {
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.55), rgba(14, 165, 233, 0.35));
  border-radius: 3px;
}

.xterm-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-muted);
  pointer-events: none;
  text-transform: uppercase;
  letter-spacing: 0.2px;
}

@keyframes fade-in { from { opacity: 0; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } }

/* ==================== MODALS ==================== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: fade-in 0.15s ease;
}
.modal {
  width: 440px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  animation: slide-up 0.2s ease;
}
.modal-wide { width: 560px; }
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle);
}
.modal-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.modal-close:hover { color: var(--text-primary); background: rgba(255,255,255,0.06); }
.modal-body { padding: 16px 20px; }
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border-subtle);
}

/* ==================== FORMS ==================== */
.form-field {
  margin-bottom: 14px;
}
.form-field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.form-field input, .form-field textarea {
  width: 100%;
  padding: 9px 12px;
  font-size: 13px;
  font-family: var(--font-sans);
  color: var(--text-primary);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color 0.15s;
  resize: vertical;
}
.form-field input:focus, .form-field textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-muted);
}
.form-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* ==================== BUTTONS ==================== */
.btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s;
  border: none;
}
.btn-primary {
  background: var(--accent);
  color: white;
}
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost {
  background: rgba(255,255,255,0.05);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}
.btn-ghost:hover { background: rgba(255,255,255,0.08); color: var(--text-primary); }
.btn-danger {
  background: var(--red-muted);
  color: var(--red-text);
}
.btn-danger:hover { background: rgba(239, 68, 68, 0.2); }
</style>
