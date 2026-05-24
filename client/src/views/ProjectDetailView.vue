<template>
  <div class="detail-root" v-if="project">
    <div class="detail-sidebar">
      <div class="sidebar-header">
        <RouterLink to="/" class="sidebar-back">← Projects</RouterLink>
        <div class="sidebar-name">{{ project.name }}</div>
        <span class="badge" :class="`badge--${derivedState?.state || 'idle'}`">
          {{ stateLabel }}
        </span>
      </div>
      <nav class="sidebar-nav">
        <RouterLink :to="`/projects/${id}/plan`" class="snav-link">📝 Plan</RouterLink>
        <RouterLink :to="`/projects/${id}/pipeline`" class="snav-link">
          🔀 Pipeline
          <span v-if="manifest.data" class="snav-chip">{{ pipelineProgress }}</span>
        </RouterLink>
        <RouterLink :to="`/projects/${id}/tasks`" class="snav-link">📋 Tasks</RouterLink>
        <RouterLink :to="`/projects/${id}/logs`" class="snav-link">📟 Logs</RouterLink>
        <RouterLink :to="`/projects/${id}/changelog`" class="snav-link">📜 Changelog</RouterLink>
      </nav>
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
        <button class="btn btn--primary" @click="showInit = true">Initialize</button>
      </div>
      <div v-else-if="project.init_status === 'initializing'" class="init-banner init-banner--progress">
        Initializing project... <span class="spinner">⟳</span>
      </div>
      <RouterView v-else />
    </div>
  </div>

  <!-- Init wizard overlay -->
  <div v-if="showInit" class="modal-overlay" @click.self="showInit = false">
    <div class="modal">
      <div class="modal-header">Initialize Project</div>
      <InitWizard :project="project" @done="onInitDone" @cancel="showInit = false" />
    </div>
  </div>

  <div v-if="!project && !loading" class="page empty-state">
    <div class="empty-title">Project not found</div>
    <RouterLink to="/" class="btn btn--secondary" style="margin-top:16px">Back to projects</RouterLink>
  </div>
  <div v-if="loading" class="page empty-state">Loading...</div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
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

const manifest = useManifestStore();
const project = computed(() => projects.byId[id.value] || null);
const derivedState = computed(() => project.value?.derived_state);
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

onMounted(async () => {
  loading.value = true;
  try {
    await projects.fetchOne(id.value);
    tasks.setProject(id.value);
    await tasks.fetchTasks(id.value);
    ws.subscribe(id.value);
    manifest.fetch(id.value);
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
  width: 220px; flex-shrink: 0;
  background: #0d0e14; border-right: 1px solid #1e1f2a;
  display: flex; flex-direction: column; overflow: hidden;
}
.sidebar-header { padding: 16px; border-bottom: 1px solid #1e1f2a; }
.sidebar-back { font-size: 12px; color: #6b7280; text-decoration: none; }
.sidebar-back:hover { color: #9ca3af; }
.sidebar-name { font-weight: 600; font-size: 14px; color: #f4f4f5; margin: 8px 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sidebar-nav { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.snav-link {
  display: block; padding: 8px 12px; border-radius: 6px;
  text-decoration: none; color: #9ca3af; font-size: 13px;
  transition: all 0.15s;
}
.snav-link:hover { background: #1e1f2a; color: #e4e4e7; }
.snav-link.router-link-active { background: #1a1a2e; color: #a78bfa; }
.snav-chip { font-size: 10px; background: #1e1f2a; color: #6b7280; padding: 1px 5px; border-radius: 8px; margin-left: auto; }

.sidebar-meta { padding: 12px 16px; margin-top: auto; border-top: 1px solid #1e1f2a; }
.meta-row { display: flex; justify-content: space-between; font-size: 11px; color: #4b5563; margin-bottom: 6px; gap: 8px; }
.meta-row span:first-child { flex-shrink: 0; color: #6b7280; }
.meta-path { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; direction: rtl; text-align: right; }

.detail-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

.init-banner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; background: #1a1a2e; border-bottom: 1px solid #2d2f4a;
}
.init-banner-text { font-size: 13px; color: #a78bfa; }
.init-banner--progress { justify-content: flex-start; gap: 12px; color: #9ca3af; }

.spinner { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal { background: #111218; border: 1px solid #2d2f3e; border-radius: 12px; width: 480px; padding: 24px; }
.modal-header { font-size: 16px; font-weight: 600; margin-bottom: 20px; color: #f4f4f5; }
</style>
