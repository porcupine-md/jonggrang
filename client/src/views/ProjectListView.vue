<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Projects</div>
        <div class="page-subtitle">{{ workspace.path || 'Loading workspace...' }}</div>
      </div>
      <RouterLink to="/import">
        <Button label="New Project" icon="pi pi-plus" />
      </RouterLink>
    </div>

    <div v-if="projects.loading" class="empty-state">Loading...</div>
    <div v-else-if="projects.list.length === 0" class="empty-state">
      <i class="pi pi-sparkles empty-icon" />
      <div class="empty-title">No projects yet</div>
      <div class="empty-desc">Import a git repo, local folder, or start fresh</div>
      <RouterLink to="/import" style="margin-top:16px">
        <Button label="Create first project" icon="pi pi-plus" />
      </RouterLink>
    </div>
    <div v-else class="project-grid">
      <div
        v-for="project in projects.list"
        :key="project.id"
        class="project-card"
        @click="openProject(project)"
      >
        <div class="project-card-header">
          <div class="project-name">{{ project.name }}</div>
          <Tag :value="stateLabel(project)" :severity="stateSeverity(project)" />
        </div>
        <div class="project-path">{{ project.path }}</div>
        <div class="project-meta">
          <span class="project-source">{{ sourceLabel(project) }}</span>
          <span class="project-date">{{ formatDate(project.last_opened_at) }}</span>
        </div>
        <div v-if="project.init_status !== 'ready'" class="project-status-bar">
          <Tag :value="project.init_status" :severity="initStatusSeverity(project.init_status)" size="small" />
          <span v-if="project.init_status === 'imported'" class="project-action-hint">Click to initialize</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import { useProjectsStore } from '../stores/projects.js';
import { useWorkspaceStore } from '../stores/workspace.js';

const router = useRouter();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();

onMounted(async () => {
  await Promise.all([workspace.fetch(), projects.fetchAll()]);
});

function openProject(project) {
  router.push(`/projects/${project.id}/plan`);
}

function stateSeverity(project) {
  const s = project.init_status === 'error' ? 'error' : (project.derived_state?.state || project.init_status || 'idle');
  return { idle: 'secondary', ready: 'success', draft: 'info', tasks_pending: 'warn', working: 'success', done: 'success', error: 'danger', importing: 'info', initializing: 'warn', imported: 'info' }[s] || 'secondary';
}

function stateLabel(project) {
  if (project.init_status === 'error') return 'Error';
  if (!project.derived_state) return project.init_status || 'idle';
  const s = project.derived_state.state;
  return { idle: 'Idle', draft: 'Draft plan', tasks_pending: 'Tasks ready', working: 'Working...', done: 'Done' }[s] || s;
}

function initStatusSeverity(status) {
  return { imported: 'info', initializing: 'warn', error: 'danger', ready: 'success' }[status] || 'secondary';
}

function sourceLabel(project) {
  if (!project.source) return '';
  if (project.source.type === 'git') return `git: ${project.source.url?.split('/').pop() || 'repo'}`;
  if (project.source.type === 'local') return 'local folder';
  return 'fresh project';
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString();
}
</script>

<style scoped>
.empty-state {
  display: flex; flex-direction: column; align-items: center;
  padding: 80px 0; color: var(--jg-text-muted); text-align: center;
}
.empty-icon { font-size: 36px; margin-bottom: 16px; color: var(--jg-green); }
.empty-title { font-size: 16px; color: var(--jg-text-muted); margin-bottom: 8px; }
.empty-desc { font-size: 12px; color: var(--jg-text-faint); }

.project-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
}
.project-card {
  background: var(--jg-card); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 16px;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.project-card:hover { border-color: var(--jg-green); background: var(--jg-hover); }
.project-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.project-name { font-weight: 600; font-size: 13px; color: var(--jg-text); }
.project-path { font-size: 10px; color: var(--jg-text-faint); margin-bottom: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-meta { display: flex; justify-content: space-between; font-size: 10px; color: var(--jg-text-faint); }
.project-status-bar { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--jg-border); display: flex; align-items: center; gap: 8px; }
.project-action-hint { font-size: 11px; color: var(--jg-green); }
</style>
