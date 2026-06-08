import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref([]);
  const projectId = ref(null);
  // Work Mode scope: when set, columns/stats only show this plan's tasks.
  const featureFilter = ref(null);

  function setProject(id) { projectId.value = id; }
  function setFeatureFilter(fid) { featureFilter.value = fid || null; }

  function replaceAll(next) { tasks.value = next; }

  function patchTask(id, patch) {
    const idx = tasks.value.findIndex(t => t.id === id);
    if (idx >= 0) tasks.value[idx] = { ...tasks.value[idx], ...patch };
  }

  const visible = computed(() =>
    featureFilter.value ? tasks.value.filter(t => t.feature_id === featureFilter.value) : tasks.value
  );

  const columns = computed(() => ({
    todo:        visible.value.filter(t => t.status === 'pending'),
    in_progress: visible.value.filter(t => t.status === 'in_progress'),
    blocked:     visible.value.filter(t => t.status === 'blocked' || t.status === 'failed'),
    done:        visible.value.filter(t => t.status === 'completed' || t.status === 'skipped'),
  }));

  const stats = computed(() => {
    const total = visible.value.length;
    const done = columns.value.done.length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  });

  async function fetchTasks(id) {
    const res = await window.fetch(`/api/projects/${id}/tasks`);
    if (!res.ok) return;
    const data = await res.json();
    replaceAll(data.tasks || []);
  }

  return { tasks, projectId, featureFilter, visible, columns, stats, setProject, setFeatureFilter, replaceAll, patchTask, fetchTasks };
});
