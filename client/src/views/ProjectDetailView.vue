<template>
  <div class="detail-root" v-if="project">
    <div class="detail-sidebar">
      <!-- Plan Mode header -->
      <div v-if="!isWorkMode" class="sidebar-header">
        <RouterLink to="/" class="sidebar-back"><i class="pi pi-arrow-left" /> Projects</RouterLink>
        <div class="sidebar-name">{{ project.name }}</div>
        <Tag :value="stateLabel" :severity="stateSeverity" size="small" />
      </div>
      <!-- Work Mode header: one plan's workspace -->
      <div v-else class="sidebar-header">
        <RouterLink :to="`/projects/${id}/plan`" class="sidebar-back"><i class="pi pi-arrow-left" /> Plans</RouterLink>
        <div class="sidebar-name" :title="workPlanTitle">{{ workPlanTitle }}</div>
        <div v-if="workBranch" class="work-branch"><i class="pi pi-code-branch" /> {{ workBranch }}</div>
        <div class="work-run-row">
          <span class="work-status" :class="`ws--${groupStatus}`">{{ groupStatus }}</span>
          <button v-if="!groupRunning" class="work-run-btn" :class="{ 'work-run-btn--failed': manifestFailed }" :disabled="runBusy || worktreeStatus === 'creating'" @click="startRun">
            <i :class="manifestFailed ? 'pi pi-refresh' : 'pi pi-play'" /> {{ runBusy ? 'Starting…' : (manifestFailed ? 'Resume' : 'Run') }}
          </button>
          <button v-else class="work-run-btn work-run-btn--stop" @click="cancelRun">
            <i class="pi pi-stop" /> Cancel
          </button>
        </div>
        <div v-if="worktreeStatus === 'creating'" class="work-wt-note"><i class="pi pi-spin pi-spinner" /> preparing worktree…</div>
        <div v-if="worktreeStatus === 'error'" class="work-wt-note work-wt-note--err">{{ worktreeError }}</div>
        <div v-if="runError" class="work-wt-note work-wt-note--err">{{ runError }}</div>
      </div>

      <nav class="sidebar-nav">
        <!-- Plan Mode: project scope -->
        <template v-if="!isWorkMode">
          <RouterLink :to="`/projects/${id}/plan`" class="snav-link"><i class="pi pi-file-edit" /> Plan</RouterLink>
          <RouterLink :to="`/projects/${id}/changelog`" class="snav-link"><i class="pi pi-history" /> Changelog</RouterLink>
          <div class="snav-divider"></div>
          <RouterLink v-if="codeEditor !== 'off'" :to="`/projects/${id}/files`" class="snav-link"><i class="pi pi-folder-open" /> Files</RouterLink>
          <RouterLink :to="`/projects/${id}/agent`" class="snav-link"><i class="pi pi-microchip-ai" /> Agent</RouterLink>
          <RouterLink :to="`/projects/${id}/terminal`" class="snav-link"><i class="pi pi-dollar" /> Terminal</RouterLink>
          <RouterLink :to="`/projects/${id}/settings`" class="snav-link"><i class="pi pi-cog" /> Settings</RouterLink>
        </template>
        <!-- Work Mode: everything scoped to this plan -->
        <template v-else>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/pipeline`" class="snav-link">
            <i class="pi pi-sitemap" /> Pipeline
            <span v-if="manifest.data" class="snav-chip">{{ pipelineProgress }}</span>
          </RouterLink>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/tasks`" class="snav-link"><i class="pi pi-list-check" /> Tasks</RouterLink>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/graph`" class="snav-link"><i class="pi pi-share-alt" /> Graph</RouterLink>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/logs`" class="snav-link">
            <i class="pi pi-desktop" /> Logs
            <span v-if="groupRunning" class="snav-chip snav-chip--live">live</span>
          </RouterLink>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/changes`" class="snav-link"><i class="pi pi-file-export" /> Changes</RouterLink>
          <div class="snav-divider"></div>
          <RouterLink v-if="codeEditor !== 'off'" :to="`/projects/${id}/plans/${featureId}/files`" class="snav-link"><i class="pi pi-folder-open" /> Files</RouterLink>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/agent`" class="snav-link"><i class="pi pi-microchip-ai" /> Agent</RouterLink>
          <RouterLink :to="`/projects/${id}/plans/${featureId}/terminal`" class="snav-link"><i class="pi pi-dollar" /> Terminal</RouterLink>
          <RouterLink :to="`/projects/${id}/settings`" class="snav-link"><i class="pi pi-cog" /> Settings</RouterLink>
        </template>
      </nav>
      <!-- Sandbox panel -->
      <div v-if="project.sandbox?.enabled" class="sandbox-panel">
        <div class="sandbox-panel-title">
          <i class="pi pi-box" />
          <span>Sandbox</span>
          <span class="sbx-status-dot" :class="`sbx-dot--${sandboxStatus || 'stopped'}`"></span>
          <span class="sbx-status-label">{{ sandboxStatus || 'stopped' }}</span>
        </div>
        <div class="sbx-container-name">{{ containerName }}</div>
        <div class="sbx-actions">
          <button class="sbx-btn" :disabled="sandboxStatus === 'starting'" @click="restartSandbox" title="Restart">
            <i class="pi pi-refresh" />
          </button>
          <button class="sbx-btn sbx-btn--rebuild" :disabled="sandboxStatus === 'starting'" @click="rebuildSandbox" title="Rebuild">
            <i class="pi pi-hammer" />
          </button>
          <button class="sbx-btn sbx-btn--stop" v-if="sandboxStatus === 'running'" @click="stopSandbox" title="Stop">
            <i class="pi pi-stop" />
          </button>
          <button class="sbx-btn sbx-btn--start" v-if="sandboxStatus === 'stopped' || sandboxStatus === 'error'" @click="startSandbox" title="Start">
            <i class="pi pi-play" />
          </button>
        </div>
      </div>

      <div class="sidebar-meta">
        <div class="meta-row"><span>Status</span><span>{{ project.init_status }}</span></div>
        <div class="meta-row"><span>Path</span><span class="meta-path">{{ project.path }}</span></div>
        <div class="meta-row" v-if="project.source?.type === 'git'">
          <span>Repo</span><span class="meta-path">{{ project.source.url }}</span>
        </div>
      </div>
    </div>
    <div class="detail-content">
      <div v-if="project.init_status === 'imported'" class="init-banner">
        <div class="init-banner-text">Project imported. Initialize it to start working.</div>
        <Button label="Initialize" @click="showInit = true" />
      </div>
      <div v-else-if="project.init_status === 'initializing'" class="init-banner init-banner--progress">
        Initializing project... <i class="pi pi-spin pi-spinner" />
      </div>
      <template v-else-if="project.sandbox?.enabled && sandboxStatus !== 'running'">
        <div class="sandbox-gate">
          <div v-if="sandboxStatus === 'starting'" class="sandbox-starting">
            <i class="pi pi-spin pi-spinner" />
            <span>Starting Docker sandbox...</span>
            <div v-if="sandboxLogTail" class="sandbox-log-mini">{{ sandboxLogTail }}</div>
          </div>
          <div v-else-if="sandboxStatus === 'error'" class="sandbox-error">
            <i class="pi pi-times-circle" />
            <span>Sandbox failed to start.</span>
            <button class="sandbox-btn" @click="startSandbox">Retry</button>
          </div>
          <div v-else class="sandbox-stopped">
            <i class="pi pi-docker" />
            <span>Docker sandbox is stopped.</span>
            <button class="sandbox-btn" @click="startSandbox">Start Sandbox</button>
          </div>
        </div>
      </template>
      <RouterView v-else :key="route.path" />
    </div>
  </div>

  <!-- Init wizard dialog -->
  <Dialog v-model:visible="showInit" header="Initialize Project" :modal="true" :style="{ width: '480px' }">
    <InitWizard :project="project" @done="onInitDone" @cancel="showInit = false" />
  </Dialog>

  <div v-if="!project && !loading" class="page empty-state">
    <div class="empty-title">Project not found</div>
    <RouterLink to="/" style="margin-top:16px">
      <Button label="Back to projects" severity="secondary" icon="pi pi-arrow-left" />
    </RouterLink>
  </div>
  <div v-if="loading" class="page empty-state">Loading...</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Dialog from 'primevue/dialog';
import { useProjectsStore } from '../stores/projects.js';
import { useTasksStore } from '../stores/tasks.js';
import { useWsStore } from '../stores/ws.js';
import { useManifestStore } from '../stores/manifest.js';
import { useOrchestrationStore } from '../stores/orchestration.js';
import InitWizard from '../components/project/InitWizard.vue';

const route = useRoute();
const id = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId || null);
const isWorkMode = computed(() => !!featureId.value);
const projects = useProjectsStore();
const tasks = useTasksStore();
const ws = useWsStore();
const loading = ref(false);
const showInit = ref(false);
const sandboxStatus = ref(null);
const sandboxLogTail = ref('');
const containerName = computed(() => project.value ? `jonggrang-${id.value}` : '');

const manifest = useManifestStore();
const orchestration = useOrchestrationStore();
const project = computed(() => projects.byId[id.value] || null);
const derivedState = computed(() => project.value?.derived_state);
const codeEditor = computed(() => project.value?.code_editor || 'off');

// ── Work Mode state ───────────────────────────────────────────
const workPlan = ref(null);            // plan record from /plans (title, branch)
const worktreeStatus = ref('idle');    // idle | creating | ready | error
const worktreeError = ref('');
const runBusy = ref(false);
const runError = ref('');

const group = computed(() => featureId.value ? orchestration.groups[featureId.value] : null);
const groupRunning = computed(() => ['running', 'queued'].includes(group.value?.status));
// A failed pipeline must be resumed (`jonggrang work --resume`) rather than
// re-started from scratch — the manifest carries the phase it died on.
const manifestFailed = computed(() => manifest.data?.status === 'failed');
const groupStatus = computed(() => group.value?.status || 'idle');
const workPlanTitle = computed(() => workPlan.value?.title || featureId.value || '');
const workBranch = computed(() => group.value?.branch || workPlan.value?.branch || '');

const pipelineProgress = computed(() => {
  if (!manifest.data) return '';
  const done = manifest.phases.filter(p => p.status === 'completed').length;
  const active = manifest.phases.filter(p => p.status !== 'skipped').length;
  return `${done}/${active}`;
});

const stateLabel = computed(() => {
  const s = derivedState.value?.state;
  return { idle: 'Idle', draft: 'Draft', tasks_pending: 'Tasks Ready', working: 'Working', done: 'Done' }[s] || (s || 'Idle');
});

const stateSeverity = computed(() => {
  const s = derivedState.value?.state || 'idle';
  return { idle: 'secondary', draft: 'info', tasks_pending: 'warn', working: 'success', done: 'success' }[s] || 'secondary';
});

// ── Work Mode actions ─────────────────────────────────────────

async function loadWorkPlan(fid) {
  try {
    const res = await fetch(`/api/projects/${id.value}/plans`);
    if (!res.ok) return;
    const plans = await res.json();
    workPlan.value = plans.find(p => p.id === fid) || null;
  } catch {}
}

async function refreshOrchestration() {
  try {
    const res = await fetch(`/api/projects/${id.value}/orchestration`);
    if (!res.ok) return;
    const view = await res.json();
    if (view && Array.isArray(view.groups) && view.groups.length) orchestration.hydrate(view);
  } catch {}
}

// Idempotent: create the plan's worktree so Agent/Terminal work pre-run.
async function ensureWorktree(fid) {
  worktreeStatus.value = 'creating';
  worktreeError.value = '';
  try {
    const res = await fetch(`/api/projects/${id.value}/plans/${fid}/worktree`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Worktree failed');
    worktreeStatus.value = 'ready';
    if (!workPlan.value?.branch && data.branch) {
      workPlan.value = { ...(workPlan.value || {}), branch: data.branch, title: workPlan.value?.title || data.title };
    }
  } catch (e) {
    worktreeStatus.value = 'error';
    worktreeError.value = e.message;
  }
}

async function enterWorkMode(fid) {
  runError.value = '';
  workPlan.value = null;
  manifest.fetch(id.value, fid);
  loadWorkPlan(fid);
  refreshOrchestration();
  ensureWorktree(fid);
}

async function startRun() {
  runBusy.value = true;
  runError.value = '';
  try {
    // Failed pipeline → resume (jonggrang work --resume) instead of a fresh start.
    const action = manifestFailed.value ? 'resume' : 'start';
    const res = await fetch(`/api/projects/${id.value}/orchestration/groups/${featureId.value}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to start run');
    if (data.run) orchestration.onStarted(data.run);
  } catch (e) {
    runError.value = e.message;
  } finally {
    runBusy.value = false;
  }
}

async function cancelRun() {
  try {
    await fetch(`/api/projects/${id.value}/orchestration/groups/${featureId.value}/cancel`, { method: 'POST' });
  } catch {}
}

watch(featureId, (fid) => {
  if (fid) enterWorkMode(fid);
}, { immediate: false });

// ── Sandbox actions ───────────────────────────────────────────

async function startSandbox() {
  sandboxLogTail.value = '';
  await fetch(`/api/projects/${id.value}/sandbox/start`, { method: 'POST' });
}

async function stopSandbox() {
  await fetch(`/api/projects/${id.value}/sandbox/stop`, { method: 'POST' });
}

async function restartSandbox() {
  sandboxStatus.value = 'starting';
  await fetch(`/api/projects/${id.value}/sandbox/restart`, { method: 'POST' });
}

async function rebuildSandbox() {
  const ok = window.confirm(
    'Rebuild will destroy the current container and create a fresh one.\n\n' +
    'Any software installed manually inside the container and changes outside the mounted volumes will be permanently lost.\n\n' +
    'Continue?'
  );
  if (!ok) return;
  sandboxLogTail.value = '';
  sandboxStatus.value = 'starting';
  await fetch(`/api/projects/${id.value}/sandbox/rebuild`, { method: 'POST' });
}

onMounted(async () => {
  loading.value = true;
  try {
    await projects.fetchOne(id.value);
    tasks.setProject(id.value);
    await tasks.fetchTasks(id.value);
    orchestration.setProject(id.value);
    ws.subscribe(id.value);
    if (featureId.value) enterWorkMode(featureId.value);

    if (project.value?.sandbox?.enabled) {
      const res = await fetch(`/api/projects/${id.value}/sandbox/status`);
      const data = await res.json();
      sandboxStatus.value = data.status;
      if (data.status === 'stopped') startSandbox();
    }

    const socket = ws.socket;
    if (socket) {
      socket.on('sandbox.status', ({ project_id, status }) => {
        if (project_id !== id.value) return;
        sandboxStatus.value = status;
      });
      socket.on('sandbox.log', ({ project_id, line }) => {
        if (project_id !== id.value) return;
        sandboxLogTail.value = line;
      });
    }
  } catch {}
  loading.value = false;
});

onUnmounted(() => {
  ws.unsubscribe(id.value);
});

watch(id, async (newId, oldId) => {
  if (oldId) ws.unsubscribe(oldId);
  if (newId) {
    await projects.fetchOne(newId);
    tasks.setProject(newId);
    await tasks.fetchTasks(newId);
    orchestration.setProject(newId);
    ws.subscribe(newId);
  }
});

async function onInitDone() {
  showInit.value = false;
  await projects.fetchOne(id.value);
}
</script>

<style scoped>
.detail-root { display: flex; height: 100%; overflow: hidden; }

.detail-sidebar {
  width: 200px; flex-shrink: 0;
  background: var(--jg-card);
  border-right: 1px solid var(--jg-border);
  display: flex; flex-direction: column; overflow: hidden;
}
.sidebar-header { padding: 16px; border-bottom: 1px solid var(--jg-border); }
.sidebar-back { font-size: 11px; color: var(--jg-text-faint); text-decoration: none; display: flex; align-items: center; gap: 4px; }
.sidebar-back:hover { color: var(--jg-text-muted); }
.sidebar-name { font-weight: 600; font-size: 13px; color: var(--jg-text); margin: 8px 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Work Mode header */
.work-branch {
  font-size: 10px; font-family: monospace; color: var(--jg-text-muted);
  display: flex; align-items: center; gap: 4px; margin-bottom: 8px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.work-run-row { display: flex; align-items: center; gap: 8px; }
.work-status {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 2px 6px; border: 1px solid var(--jg-border); color: var(--jg-text-faint);
}
.ws--running   { color: var(--jg-green); border-color: var(--jg-green); animation: pulse 1.2s infinite; }
.ws--queued    { color: #f59e0b; border-color: #f59e0b; }
.ws--completed { color: var(--jg-green); }
.ws--failed    { color: var(--jg-red); border-color: var(--jg-red); }
.ws--cancelled { color: var(--jg-red); }
.work-run-btn {
  display: inline-flex; align-items: center; gap: 5px;
  flex: 1; justify-content: center;
  padding: 4px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
  background: var(--jg-green); color: #000; border: 1px solid var(--jg-green);
  transition: opacity 0.15s;
}
.work-run-btn:hover:not(:disabled) { opacity: 0.85; }
.work-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.work-run-btn--failed { background: var(--jg-red); border-color: var(--jg-red); color: #fff; }
.work-run-btn--stop { background: transparent; color: var(--jg-red); border-color: var(--jg-red); }
.work-run-btn--stop:hover { background: color-mix(in oklch, var(--jg-red) 12%, transparent); opacity: 1; }
.work-wt-note {
  margin-top: 8px; font-size: 10px; color: var(--jg-text-faint);
  display: flex; align-items: center; gap: 5px;
  overflow: hidden; text-overflow: ellipsis;
}
.work-wt-note--err { color: var(--jg-red); white-space: normal; }

.sidebar-nav { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.snav-link {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--radius);
  text-decoration: none; color: var(--jg-text-muted); font-size: 12px;
  transition: all 0.15s;
}
.snav-link:hover { background: var(--jg-hover); color: var(--jg-text); }
.snav-link.router-link-active { background: color-mix(in oklch, var(--jg-green) 12%, transparent); color: var(--jg-green); }
.snav-chip { font-size: 9px; background: var(--jg-hover); color: var(--jg-text-faint); padding: 1px 4px; border-radius: 0px; margin-left: auto; letter-spacing: 0.04em; }
.snav-chip--live { color: var(--jg-green); animation: pulse 1.2s infinite; }
.snav-divider { height: 1px; background: var(--jg-border); margin: 4px 8px; }

.sandbox-panel {
  margin-top: auto;
  padding: 10px 14px;
  border-top: 1px solid var(--jg-border);
  background: color-mix(in oklch, var(--jg-green) 5%, transparent);
}
.sandbox-panel-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--jg-text-faint); margin-bottom: 6px;
}
.sandbox-panel-title .pi-box { font-size: 11px; }
.sbx-status-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-left: auto;
}
.sbx-dot--running  { background: var(--jg-green); box-shadow: 0 0 4px var(--jg-green); }
.sbx-dot--starting { background: #f59e0b; box-shadow: 0 0 4px #f59e0b; animation: pulse 1s infinite; }
.sbx-dot--stopped  { background: var(--jg-text-faint); }
.sbx-dot--error    { background: var(--jg-red); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.sbx-status-label { font-size: 9px; color: var(--jg-text-faint); }
.sbx-container-name {
  font-size: 9px; color: var(--jg-text-faint); font-family: monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-bottom: 8px;
}
.sbx-actions { display: flex; gap: 6px; }
.sbx-btn {
  flex: 1; padding: 5px; border: 1px solid var(--jg-border);
  background: var(--jg-hover); color: var(--jg-text-muted);
  cursor: pointer; font-size: 11px; transition: all 0.15s;
  display: flex; align-items: center; justify-content: center;
}
.sbx-btn:hover:not(:disabled) { background: var(--jg-card); color: var(--jg-text); }
.sbx-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.sbx-btn--stop:hover:not(:disabled)    { color: var(--jg-red); border-color: var(--jg-red); }
.sbx-btn--start:hover:not(:disabled)   { color: var(--jg-green); border-color: var(--jg-green); }
.sbx-btn--rebuild:hover:not(:disabled) { color: #f59e0b; border-color: #f59e0b; }

.sidebar-meta { padding: 12px 16px; border-top: 1px solid var(--jg-border); }
.meta-row { display: flex; justify-content: space-between; font-size: 11px; color: var(--jg-text-faint); margin-bottom: 6px; gap: 8px; }
.meta-row span:first-child { flex-shrink: 0; }
.meta-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; direction: rtl; text-align: right; color: var(--jg-text-muted); }

.detail-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

.init-banner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 20px;
  background: color-mix(in oklch, var(--jg-green) 8%, var(--jg-card));
  border-bottom: 1px solid var(--jg-border);
}
.init-banner-text { font-size: 12px; color: var(--jg-green); }
.init-banner--progress { justify-content: flex-start; gap: 12px; color: var(--jg-text-muted); }

.empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; text-align: center;
}
.empty-title { font-size: 16px; color: var(--jg-text-muted); }

.sandbox-gate {
  flex: 1; display: flex; align-items: center; justify-content: center;
}
.sandbox-starting, .sandbox-error, .sandbox-stopped {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--jg-text-muted); font-size: 13px;
}
.sandbox-starting .pi-spinner { font-size: 24px; color: var(--jg-green); }
.sandbox-error .pi-times-circle { font-size: 24px; color: var(--jg-red); }
.sandbox-stopped .pi-docker { font-size: 24px; color: var(--jg-text-faint); }
.sandbox-log-mini {
  font-size: 10px; color: var(--jg-text-faint); max-width: 400px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sandbox-btn {
  padding: 6px 16px; background: var(--jg-green); color: #000;
  border: none; cursor: pointer; font-family: inherit; font-size: 12px;
  transition: opacity 0.15s;
}
.sandbox-btn:hover { opacity: 0.85; }
</style>
