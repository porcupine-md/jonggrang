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

    <!-- Filter -->
    <div v-if="projects.list.length > 0" class="filter-bar">
      <i class="pi pi-search filter-icon" />
      <input
        v-model="filter"
        class="filter-input"
        placeholder="Filter projects..."
        @keydown.escape="filter = ''"
      />
      <button v-if="filter" class="filter-clear" @click="filter = ''">
        <i class="pi pi-times" />
      </button>
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
    <div v-else-if="filtered.length === 0" class="empty-state">
      <div class="empty-title">No matches for "{{ filter }}"</div>
    </div>
    <div v-else class="project-grid">
      <div
        v-for="project in filtered"
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

        <!-- Delete button -->
        <button class="card-delete" @click.stop="confirmDelete(project)" title="Delete project">
          <i class="pi pi-trash" />
        </button>
      </div>
    </div>

    <!-- Delete confirm dialog -->
    <Dialog v-model:visible="deleteDialog" header="Delete Project" :modal="true" :style="{ width: '400px' }">
      <div class="delete-dialog-body">
        <div class="delete-dialog-name">{{ deleteTarget?.name }}</div>
        <div class="delete-dialog-desc">Remove this project from Jonggrang?</div>
        <label class="delete-files-label">
          <input type="checkbox" v-model="deleteFiles" />
          Also delete project files from disk
        </label>
      </div>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <Button label="Cancel" severity="secondary" @click="deleteDialog = false" />
          <Button label="Delete" severity="danger" :disabled="deleting" @click="doDelete" />
        </div>
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Dialog from 'primevue/dialog';
import { useProjectsStore } from '../stores/projects.js';
import { useWorkspaceStore } from '../stores/workspace.js';

const router = useRouter();
const projects = useProjectsStore();
const workspace = useWorkspaceStore();

const filter = ref('');
const deleteDialog = ref(false);
const deleteTarget = ref(null);
const deleteFiles = ref(false);
const deleting = ref(false);

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return projects.list;
  return projects.list.filter(p =>
    p.name.toLowerCase().includes(q) ||
    p.path?.toLowerCase().includes(q) ||
    p.source?.url?.toLowerCase().includes(q)
  );
});

onMounted(async () => {
  await Promise.all([workspace.fetch(), projects.fetchAll()]);
});

function openProject(project) {
  router.push(`/projects/${project.id}/plan`);
}

function confirmDelete(project) {
  deleteTarget.value = project;
  deleteFiles.value = false;
  deleteDialog.value = true;
}

async function doDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await projects.deleteProject(deleteTarget.value.id, deleteFiles.value);
    deleteDialog.value = false;
    deleteTarget.value = null;
  } catch (e) {
    console.error(e);
  } finally {
    deleting.value = false;
  }
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
  return new Date(iso).toLocaleDateString();
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

/* Filter bar */
.filter-bar {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 16px;
  background: var(--jg-card); border: 1px solid var(--jg-border);
  padding: 6px 10px;
}
.filter-icon { font-size: 11px; color: var(--jg-text-faint); flex-shrink: 0; }
.filter-input {
  flex: 1; background: transparent; border: none; outline: none;
  font-family: var(--font-mono); font-size: 12px; color: var(--jg-text);
}
.filter-input::placeholder { color: var(--jg-text-faint); }
.filter-clear {
  background: none; border: none; cursor: pointer; padding: 0;
  color: var(--jg-text-faint); font-size: 10px;
}
.filter-clear:hover { color: var(--jg-text-muted); }

/* Grid */
.project-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
}

/* Card */
.project-card {
  position: relative;
  background: var(--jg-card); border: 1px solid var(--jg-border); padding: 16px;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
}
.project-card:hover { border-color: var(--jg-green); background: var(--jg-hover); }
.project-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.project-name { font-weight: 600; font-size: 13px; color: var(--jg-text); }
.project-path { font-size: 10px; color: var(--jg-text-faint); margin-bottom: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-meta { display: flex; justify-content: space-between; font-size: 10px; color: var(--jg-text-faint); }
.project-status-bar { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--jg-border); display: flex; align-items: center; gap: 8px; }
.project-action-hint { font-size: 11px; color: var(--jg-green); }

/* Delete button */
.card-delete {
  position: absolute; bottom: 8px; right: 8px;
  background: none; border: none; cursor: pointer; padding: 4px 6px;
  color: var(--jg-text-faint); font-size: 11px;
  opacity: 0; transition: opacity 0.15s, color 0.15s;
  line-height: 1;
}
.project-card:hover .card-delete { opacity: 1; }
.card-delete:hover { color: var(--jg-red) !important; }

/* Delete dialog */
.delete-dialog-body { display: flex; flex-direction: column; gap: 10px; }
.delete-dialog-name { font-weight: 600; font-size: 13px; color: var(--jg-text); }
.delete-dialog-desc { font-size: 12px; color: var(--jg-text-muted); }
.delete-files-label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--jg-text-muted); margin-top: 4px; cursor: pointer; }
</style>
