import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useProjectsStore = defineStore('projects', () => {
  const list = ref([]);
  const loading = ref(false);
  const error = ref(null);

  const byId = computed(() => Object.fromEntries(list.value.map(p => [p.id, p])));

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      const res = await window.fetch('/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const data = await res.json();
      list.value = data.projects || [];
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchOne(id) {
    const res = await window.fetch(`/api/projects/${id}`);
    if (!res.ok) throw new Error('Project not found');
    const data = await res.json();
    const idx = list.value.findIndex(p => p.id === id);
    if (idx >= 0) list.value[idx] = data;
    else list.value.push(data);
    return data;
  }

  async function importProject(name, source) {
    const res = await window.fetch('/api/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Import failed');
    }
    const data = await res.json();
    await fetchAll();
    return data;
  }

  async function initProject(id, opts) {
    const res = await window.fetch(`/api/projects/${id}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Init failed');
    }
    return res.json();
  }

  async function deleteProject(id, deleteFiles = false) {
    const res = await window.fetch(`/api/projects/${id}?delete_files=${deleteFiles}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error('Delete failed');
    list.value = list.value.filter(p => p.id !== id);
  }

  function updateDerivedState(projectId, state) {
    const p = list.value.find(p => p.id === projectId);
    if (p) p.derived_state = state;
  }

  function updateInitStatus(projectId, status, error = null) {
    const p = list.value.find(p => p.id === projectId);
    if (p) {
      p.init_status = status;
      if (error) p.init_error = error;
    }
  }

  return {
    list, loading, error, byId,
    fetchAll, fetchOne, importProject, initProject, deleteProject,
    updateDerivedState, updateInitStatus,
  };
});
