<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Projects</div>
        <div class="page-subtitle">{{ workspace.path || 'Loading workspace...' }}</div>
      </div>
      <RouterLink to="/import" class="btn btn--primary">+ New Project</RouterLink>
    </div>

    <div v-if="projects.loading" class="empty-state">Loading...</div>
    <div v-else-if="projects.list.length === 0" class="empty-state">
      <div class="empty-icon">🎭</div>
      <div class="empty-title">No projects yet</div>
      <div class="empty-desc">Import a git repo, local folder, or start fresh</div>
      <RouterLink to="/import" class="btn btn--primary" style="margin-top:16px">Create first project</RouterLink>
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
          <span class="badge" :class="`badge--${stateClass(project)}`">
            {{ stateLabel(project) }}
          </span>
        </div>
        <div class="project-path">{{ project.path }}</div>
        <div class="project-meta">
          <span class="project-source">{{ sourceLabel(project) }}</span>
          <span class="project-date">{{ formatDate(project.last_opened_at) }}</span>
        </div>
        <div v-if="project.init_status !== 'ready'" class="project-status-bar">
          <span class="badge" :class="`badge--${project.init_status}`">{{ project.init_status }}</span>
          <span v-if="project.init_status === 'imported'" class="project-action-hint">Click to initialize</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
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

function stateClass(project) {
  if (project.init_status === 'error') return 'error';
  if (!project.derived_state) return project.init_status || 'idle';
  return project.derived_state.state || 'idle';
}

function stateLabel(project) {
  if (project.init_status === 'error') return 'Error';
  if (!project.derived_state) return project.init_status || 'idle';
  const s = project.derived_state.state;
  return { idle: 'Idle', draft: 'Draft plan', tasks_pending: 'Tasks ready', working: 'Working...', done: 'Done' }[s] || s;
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
  padding: 80px 0; color: #6b7280; text-align: center;
}
.empty-icon { font-size: 48px; margin-bottom: 16px; }
.empty-title { font-size: 18px; color: #9ca3af; margin-bottom: 8px; }
.empty-desc { font-size: 13px; }

.project-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;
}
.project-card {
  background: #111218; border: 1px solid #1e1f2a; border-radius: 10px; padding: 16px;
  cursor: pointer; transition: border-color 0.15s;
}
.project-card:hover { border-color: #7c3aed; }
.project-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.project-name { font-weight: 600; font-size: 15px; color: #f4f4f5; }
.project-path { font-size: 11px; color: #4b5563; font-family: monospace; margin-bottom: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-meta { display: flex; justify-content: space-between; font-size: 11px; color: #6b7280; }
.project-status-bar { margin-top: 10px; padding-top: 10px; border-top: 1px solid #1e1f2a; display: flex; align-items: center; gap: 8px; }
.project-action-hint { font-size: 11px; color: #7c3aed; }
</style>
