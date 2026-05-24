import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref([]);
  const projectId = ref(null);

  function setProject(id) { projectId.value = id; }

  function replaceAll(next) { tasks.value = next; }

  function patchTask(id, patch) {
    const idx = tasks.value.findIndex(t => t.id === id);
    if (idx >= 0) tasks.value[idx] = { ...tasks.value[idx], ...patch };
  }

  const columns = computed(() => ({
    todo:        tasks.value.filter(t => t.status === 'pending'),
    in_progress: tasks.value.filter(t => t.status === 'in_progress'),
    blocked:     tasks.value.filter(t => t.status === 'blocked' || t.status === 'failed'),
    done:        tasks.value.filter(t => t.status === 'completed' || t.status === 'skipped'),
  }));

  const stats = computed(() => {
    const total = tasks.value.length;
    const done = columns.value.done.length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  });

  async function fetchTasks(id) {
    const res = await window.fetch(`/api/projects/${id}/tasks`);
    if (!res.ok) return;
    const data = await res.json();
    replaceAll(data.tasks || []);
  }

  return { tasks, projectId, columns, stats, setProject, replaceAll, patchTask, fetchTasks };
});
