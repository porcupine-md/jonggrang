import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useWorkspaceStore = defineStore('workspace', () => {
  const path = ref('');
  const projectCount = ref(0);
  const loading = ref(false);
  const error = ref(null);

  async function fetch() {
    loading.value = true;
    error.value = null;
    try {
      const res = await window.fetch('/api/workspace');
      const data = await res.json();
      path.value = data.path || '';
      projectCount.value = data.project_count || 0;
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function update(newPath) {
    const res = await window.fetch('/api/workspace', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    });
    if (!res.ok) throw new Error((await res.json()).error?.message || 'Failed');
    const data = await res.json();
    path.value = data.path;
    return data.path;
  }

  return { path, projectCount, loading, error, fetch, update };
});
