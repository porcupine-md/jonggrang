import { ref, onMounted, onBeforeUnmount } from 'vue';
import { io } from 'socket.io-client';

function toActiveManifest(entry) {
  if (!entry) return null;

  return {
    featureId: entry.featureId,
    manifest: {
      description: entry.description,
      work_type: entry.workType,
      status: entry.status,
      current_phase: entry.currentPhase,
      active_phases: entry.activePhases,
      phases: entry.phases,
      validation: entry.validation,
    },
  };
}

function selectManifestEntry(list, currentFeatureId) {
  const running = list.find(item => item.status === 'running' || item.status === 'in_progress');
  const active = currentFeatureId ? list.find(item => item.featureId === currentFeatureId) : null;
  return running || active || list[0] || null;
}

export function useJonggrangRuntime({ requestJson, reportError, onPlanUpdate }) {
  const socket = io({ transports: ['websocket'], autoConnect: false });

  const isRunning = ref(false);
  const logs = ref('');
  const rawTasks = ref([]);
  const projectConfig = ref(null);
  const activeManifest = ref(null);
  const compactionState = ref(null);
  const manifests = ref([]);

  let manifestPollTimer = null;
  let compactionPollTimer = null;

  async function runWithError(operation, fallbackMessage) {
    try {
      return await operation();
    } catch (error) {
      reportError(error, fallbackMessage);
      return null;
    }
  }

  function syncActiveManifest(list) {
    manifests.value = list;
    const target = selectManifestEntry(list, activeManifest.value?.featureId);
    if (target) {
      activeManifest.value = toActiveManifest(target);
    }
  }

  async function fetchManifest(featureId) {
    if (!featureId) return;
    const manifest = await runWithError(
      () => requestJson(`/api/jonggrang/manifests/${featureId}`),
      'Failed to load manifest.',
    );
    if (manifest?.manifest) activeManifest.value = manifest;
  }

  async function fetchManifests() {
    const nextManifests = await runWithError(
      () => requestJson('/api/jonggrang/manifests'),
      'Failed to refresh manifests.',
    );
    if (!nextManifests) return;

    manifests.value = nextManifests;
    if (!activeManifest.value && nextManifests.length > 0) {
      await fetchManifest(nextManifests[0].featureId);
      if (['running', 'in_progress'].includes(activeManifest.value?.manifest?.status)) {
        startManifestPoll(nextManifests[0].featureId);
      }
      return;
    }

    const target = selectManifestEntry(nextManifests, activeManifest.value?.featureId);
    if (target && activeManifest.value?.featureId !== target.featureId) {
      await fetchManifest(target.featureId);
    }
  }

  async function fetchCompaction() {
    const state = await runWithError(
      () => requestJson('/api/jonggrang/compaction'),
      'Failed to load compaction state.',
    );
    if (state) compactionState.value = state;
  }

  function stopManifestPoll() {
    if (manifestPollTimer) {
      clearInterval(manifestPollTimer);
      manifestPollTimer = null;
    }
  }

  function startManifestPoll(featureId) {
    stopManifestPoll();

    if (featureId) {
      manifestPollTimer = setInterval(() => {
        void fetchManifest(featureId);
      }, 2000);
      return;
    }

    manifestPollTimer = setInterval(async () => {
      await fetchManifests();
      if (activeManifest.value) stopManifestPoll();
    }, 2000);
  }

  function clearLogs() {
    logs.value = '';
  }

  const handleStatus = (payload) => {
    isRunning.value = payload.isRunning;
  };

  const handleTasksUpdate = (payload) => {
    if (payload?.tasks) rawTasks.value = payload.tasks;
  };

  const handleConfigUpdate = (payload) => {
    if (payload) projectConfig.value = payload;
  };

  const handleLog = (payload) => {
    logs.value += typeof payload === 'string' ? payload : (payload?.data || '');
  };

  const handleOrchestrationComplete = ({ featureId }) => {
    stopManifestPoll();
    if (activeManifest.value?.featureId === featureId) {
      void fetchManifest(featureId);
    }
    void fetchManifests();
  };

  const handleManifestsUpdate = (list) => {
    syncActiveManifest(list);
  };

  const handlePlanUpdate = onPlanUpdate ? (d) => onPlanUpdate(d) : null;

  onMounted(() => {
    socket.connect();
    socket.on('jonggrang_status', handleStatus);
    socket.on('tasks_update', handleTasksUpdate);
    socket.on('config_update', handleConfigUpdate);
    socket.on('log', handleLog);
    socket.on('orchestration_complete', handleOrchestrationComplete);
    socket.on('manifests_update', handleManifestsUpdate);
    if (handlePlanUpdate) socket.on('plan_update', handlePlanUpdate);

    void fetchManifests();
    void fetchCompaction();
    compactionPollTimer = setInterval(() => {
      void fetchCompaction();
    }, 10000);
  });

  onBeforeUnmount(() => {
    if (compactionPollTimer) {
      clearInterval(compactionPollTimer);
      compactionPollTimer = null;
    }

    stopManifestPoll();
    socket.off('jonggrang_status', handleStatus);
    socket.off('tasks_update', handleTasksUpdate);
    socket.off('config_update', handleConfigUpdate);
    socket.off('log', handleLog);
    socket.off('orchestration_complete', handleOrchestrationComplete);
    socket.off('manifests_update', handleManifestsUpdate);
    if (handlePlanUpdate) socket.off('plan_update', handlePlanUpdate);
    socket.disconnect();
  });

  return {
    isRunning,
    logs,
    rawTasks,
    projectConfig,
    activeManifest,
    compactionState,
    fetchManifest,
    fetchManifests,
    startManifestPoll,
    clearLogs,
  };
}
