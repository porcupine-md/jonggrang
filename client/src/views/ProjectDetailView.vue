<template>
  <div class="detail-root" v-if="project">
    <div class="detail-sidebar">
      <div class="sidebar-header">
        <RouterLink to="/" class="sidebar-back"><i class="pi pi-arrow-left" /> Projects</RouterLink>
        <div class="sidebar-name">{{ project.name }}</div>
        <Tag :value="stateLabel" :severity="stateSeverity" size="small" />
      </div>
      <nav class="sidebar-nav">
        <!-- Plan Mode: idle / draft -->
        <template v-if="!isWorkMode">
          <RouterLink :to="`/projects/${id}/plan`" class="snav-link"><i class="pi pi-file-edit" /> Plan</RouterLink>
          <RouterLink :to="`/projects/${id}/changelog`" class="snav-link"><i class="pi pi-history" /> Changelog</RouterLink>
        </template>
        <!-- Work Mode: tasks_pending / working / done -->
        <template v-else>
          <RouterLink :to="`/projects/${id}/plan`" class="snav-link snav-back"><i class="pi pi-arrow-left" /> Plan</RouterLink>
          <div class="snav-divider"></div>
          <RouterLink :to="`/projects/${id}/pipeline`" class="snav-link">
            <i class="pi pi-sitemap" /> Pipeline
            <span v-if="manifest.data" class="snav-chip">{{ pipelineProgress }}</span>
          </RouterLink>
          <RouterLink :to="`/projects/${id}/tasks`" class="snav-link"><i class="pi pi-list-check" /> Tasks</RouterLink>
          <RouterLink :to="`/projects/${id}/logs`" class="snav-link"><i class="pi pi-desktop" /> Logs</RouterLink>
        </template>
        <!-- Always visible -->
        <div class="snav-divider"></div>
        <RouterLink :to="`/projects/${id}/agent`" class="snav-link"><i class="pi pi-microchip-ai" /> Agent</RouterLink>
        <RouterLink :to="`/projects/${id}/terminal`" class="snav-link"><i class="pi pi-dollar" /> Terminal</RouterLink>
        <RouterLink :to="`/projects/${id}/settings`" class="snav-link"><i class="pi pi-cog" /> Settings</RouterLink>
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
      <RouterView v-else />
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
import InitWizard from '../components/project/InitWizard.vue';

const route = useRoute();
const id = computed(() => route.params.id);
const projects = useProjectsStore();
const tasks = useTasksStore();
const ws = useWsStore();
const loading = ref(false);
const showInit = ref(false);
const sandboxStatus = ref(null);
const sandboxLogTail = ref('');
const containerName = computed(() => project.value ? `jonggrang-${id.value}` : '');

const manifest = useManifestStore();
const project = computed(() => projects.byId[id.value] || null);
const derivedState = computed(() => project.value?.derived_state);
const isWorkMode = computed(() => {
  const s = derivedState.value?.state;
  return ['tasks_pending', 'working', 'done'].includes(s);
});

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
    ws.subscribe(id.value);
    manifest.fetch(id.value);

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

.sidebar-nav { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.snav-link {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--radius);
  text-decoration: none; color: var(--jg-text-muted); font-size: 12px;
  transition: all 0.15s;
}
.snav-link:hover { background: var(--jg-hover); color: var(--jg-text); }
.snav-link.router-link-active { background: color-mix(in oklch, var(--jg-green) 12%, transparent); color: var(--jg-green); }
.snav-chip { font-size: 9px; background: var(--jg-hover); color: var(--jg-text-faint); padding: 1px 4px; border-radius: 0px; margin-left: auto; letter-spacing: 0.04em; }
.snav-back { color: var(--jg-text-faint) !important; font-size: 11px; }
.snav-back:hover { color: var(--jg-text-muted) !important; }
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
