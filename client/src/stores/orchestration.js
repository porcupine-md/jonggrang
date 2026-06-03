import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

const LOG_MAX = 300;

// Normalize a serialized group (snake_case from the server) into the store shape.
function normGroup(g) {
  return {
    featureId: g.feature_id,
    branch: g.branch,
    title: g.title,
    taskIds: g.task_ids || [],
    status: g.status,
    worktreePath: g.worktree_path,
    baseSha: g.base_sha,
    pid: g.pid || null,
    committed: !!g.committed,
    pushed: !!g.pushed,
    error: g.error || null,
    log: (g.log_tail || []).slice(-LOG_MAX),
  };
}

export const useOrchestrationStore = defineStore('orchestration', () => {
  const projectId = ref(null);
  const status = ref('idle');           // idle | running | completed | cancelled
  const startedAt = ref(null);
  const groups = ref({});               // featureId -> group

  const groupList = computed(() =>
    Object.values(groups.value).sort((a, b) => (a.title || '').localeCompare(b.title || ''))
  );
  const running = computed(() =>
    groupList.value.some(g => g.status === 'running' || g.status === 'queued')
  );
  const hasRun = computed(() => groupList.value.length > 0);

  function setProject(id) {
    if (projectId.value === id) return;
    projectId.value = id;
    reset();
  }

  function reset() {
    status.value = 'idle';
    startedAt.value = null;
    groups.value = {};
  }

  // Hydrate from a full run view (subscribe snapshot or GET /orchestration).
  function hydrate(view) {
    if (!view) return;
    status.value = view.status || 'idle';
    startedAt.value = view.started_at || null;
    const next = {};
    for (const g of (view.groups || [])) next[g.feature_id] = normGroup(g);
    groups.value = next;
  }

  function onStarted(run) { hydrate(run); status.value = 'running'; }

  function onGroupStarted({ feature_id, branch, title, pid }) {
    const g = groups.value[feature_id] || { featureId: feature_id, taskIds: [], log: [] };
    groups.value[feature_id] = { ...g, branch, title, pid, status: 'running' };
  }

  function onGroupLog({ feature_id, line }) {
    const g = groups.value[feature_id];
    if (!g) return;
    g.log.push(line);
    if (g.log.length > LOG_MAX) g.log.shift();
  }

  function onGroupCompleted({ feature_id, committed }) {
    const g = groups.value[feature_id];
    if (g) { g.status = 'completed'; g.committed = !!committed; }
  }

  function onGroupFailed({ feature_id, error }) {
    const g = groups.value[feature_id];
    if (g) { g.status = 'failed'; g.error = error; }
  }

  function onGroupPushed({ feature_id }) {
    const g = groups.value[feature_id];
    if (g) g.pushed = true;
  }

  function onCompleted({ run }) {
    if (run) hydrate(run);
    status.value = 'completed';
  }

  return {
    projectId, status, startedAt, groups,
    groupList, running, hasRun,
    setProject, reset, hydrate,
    onStarted, onGroupStarted, onGroupLog,
    onGroupCompleted, onGroupFailed, onGroupPushed, onCompleted,
  };
});
