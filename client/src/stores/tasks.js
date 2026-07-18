import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref([]);
  const projectId = ref(null);
  // Work Mode scope: when set, columns/stats only show this plan's tasks.
  const featureFilter = ref(null);

  function setProject(id) { projectId.value = id; }
  function setFeatureFilter(fid) { featureFilter.value = fid || null; }

  // Merge by id so unchanged tasks keep their object identity and position.
  // A wholesale array swap on every socket push made the kanban TransitionGroup
  // re-diff and replay enter/move animations, causing cards to visibly overlap.
  function replaceAll(next) {
    const incoming = next || [];
    const prevById = new Map(tasks.value.map(t => [t.id, t]));
    tasks.value = incoming.map(t => {
      const prev = prevById.get(t.id);
      // Reuse the existing reference when nothing changed to avoid needless re-render.
      if (prev && shallowEqual(prev, t)) return prev;
      return t;
    });
  }

  function shallowEqual(a, b) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => a[k] === b[k]);
  }

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
