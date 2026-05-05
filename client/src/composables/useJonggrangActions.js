export function useJonggrangActions({
  requestJson,
  clearRequestError,
  setRequestError,
  projectConfig,
  activeManifest,
  fetchManifest,
  fetchManifests,
  startManifestPoll,
  clearLogs,
  selectedTaskId,
  showWorkModal,
  workDesc,
  showPlanModal,
  planDesc,
  newTask,
  showNewTaskForm,
}) {
  async function api(url, body) {
    return requestJson(url, { method: 'POST', body });
  }

  async function runSafely(operation, fallbackMessage) {
    try {
      return await operation();
    } catch (error) {
      setRequestError(error, fallbackMessage);
      return null;
    }
  }

  async function runWork() {
    const description = workDesc.value.trim();
    if (!description) return;

    clearRequestError();
    const tool = projectConfig.value?.tool || 'opencode';
    const response = await runSafely(
      () => api('/api/jonggrang/start', { tool, description }),
      'Failed to start work.',
    );
    if (!response) return;

    clearLogs();
    showWorkModal.value = false;
    workDesc.value = '';
    if (response.featureId) {
      await fetchManifest(response.featureId);
      startManifestPoll(response.featureId);
    } else {
      startManifestPoll(null);
    }
    await fetchManifests();
  }

  async function runPlan() {
    const description = planDesc.value.trim();
    if (!description) return;

    clearRequestError();
    const response = await runSafely(
      () => api('/api/jonggrang/plan', { description }),
      'Failed to start planning.',
    );
    if (!response) return;

    clearLogs();
    planDesc.value = '';
    // Don't close modal — plan_update socket event advances to review stage
  }

  async function stopWork() {
    clearRequestError();
    await runSafely(() => api('/api/jonggrang/stop'), 'Failed to stop work.');
  }

  async function startTask(taskId) {
    clearRequestError();
    const tool = projectConfig.value?.tool || 'opencode';
    const response = await runSafely(
      () => api('/api/jonggrang/start', { taskId, tool }),
      'Failed to start task.',
    );
    if (!response) return;

    clearLogs();
  }

  async function startReview() {
    clearRequestError();
    const response = await runSafely(
      () => api('/api/jonggrang/review'),
      'Failed to start review.',
    );
    if (!response) return;

    clearLogs();
  }

  async function addTask() {
    const title = newTask.value.title.trim();
    if (!title) return;

    clearRequestError();
    const response = await runSafely(
      () => api('/api/jonggrang/tasks', { ...newTask.value, title }),
      'Failed to create task.',
    );
    if (!response) return;

    newTask.value = { title: '', description: '', priority: 1 };
    showNewTaskForm.value = false;
  }

  async function deleteTask(id) {
    clearRequestError();
    const response = await runSafely(
      () => requestJson(`/api/jonggrang/tasks/${id}`, { method: 'DELETE' }),
      'Failed to delete task.',
    );
    if (!response) return;

    if (selectedTaskId.value === id) {
      selectedTaskId.value = null;
    }
  }

  async function updateStatus(id, status) {
    clearRequestError();
    await runSafely(
      () => requestJson(`/api/jonggrang/tasks/${id}`, { method: 'PATCH', body: { status } }),
      'Failed to update task status.',
    );
  }

  async function resumePipeline() {
    clearRequestError();
    const featureId = activeManifest.value?.featureId;
    const response = await runSafely(
      () => api('/api/jonggrang/orchestrate/resume', featureId ? { featureId } : {}),
      'Failed to resume pipeline.',
    );
    if (!response?.featureId) return;

    clearLogs();
    await fetchManifest(response.featureId);
    startManifestPoll(response.featureId);
  }

  return {
    runWork,
    runPlan,
    stopWork,
    startTask,
    startReview,
    addTask,
    deleteTask,
    updateStatus,
    resumePipeline,
  };
}
