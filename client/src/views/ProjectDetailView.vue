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
        <Button label="Initialize" @click="showInit = true" />
      </div>
      <div v-else-if="project.init_status === 'initializing'" class="init-banner init-banner--progress">
        Initializing project... <i class="pi pi-spin pi-spinner" />
      </div>
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

.sidebar-meta { padding: 12px 16px; margin-top: auto; border-top: 1px solid var(--jg-border); }
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
</style>
