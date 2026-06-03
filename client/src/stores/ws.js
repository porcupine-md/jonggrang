import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io } from 'socket.io-client';
import { useProjectsStore } from './projects.js';
import { useTasksStore } from './tasks.js';
import { useProcessStore } from './process.js';
import { useManifestStore } from './manifest.js';
import { useOrchestrationStore } from './orchestration.js';

export const useWsStore = defineStore('ws', () => {
  const socket = ref(null);
  const connected = ref(false);
  const connecting = ref(false);
  const subscribed = ref(new Set());

  function connect() {
    if (socket.value?.connected || connecting.value) return;
    connecting.value = true;

    const s = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

    s.on('connect', () => { connected.value = true; connecting.value = false; });
    s.on('connect_error', () => { connecting.value = false; });
    s.on('disconnect', () => { connected.value = false; connecting.value = false; });

    // Multi-project events
    s.on('subscribed', ({ project_id, snapshot }) => {
      const projects = useProjectsStore();
      const tasks = useTasksStore();
      const proc = useProcessStore();
      if (snapshot) {
        if (snapshot.state) projects.updateDerivedState(project_id, snapshot.state);
        if (snapshot.tasks) tasks.replaceAll(snapshot.tasks);
        if (snapshot.process) proc.setRunning(snapshot.process);
        const orch = useOrchestrationStore();
        if (orch.projectId === project_id && snapshot.orchestration) orch.hydrate(snapshot.orchestration);
      }
    });

    s.on('state', ({ project_id, state }) => {
      useProjectsStore().updateDerivedState(project_id, state);
    });

    s.on('tasks.update', ({ project_id, tasks }) => {
      if (useTasksStore().projectId === project_id) {
        useTasksStore().replaceAll(tasks);
      }
    });

    s.on('process.started', ({ project_id, command, pid }) => {
      useProcessStore().setRunning({ command, pid });
    });

    s.on('process.exited', () => {
      useProcessStore().setExited();
    });

    s.on('process.log', ({ line, seq, task_id }) => {
      const proc = useProcessStore();
      proc.appendLog({ seq, line });
      if (task_id) proc.appendTaskLog(task_id, { seq, line });
    });

    s.on('task.started', ({ task_id, started_at, agent }) => {
      useTasksStore().patchTask(task_id, { status: 'in_progress', started_at, agent });
    });

    s.on('task.completed', ({ task_id, completed_at, duration_ms }) => {
      useTasksStore().patchTask(task_id, { status: 'completed', completed_at, duration_ms });
    });

    s.on('task.failed', ({ task_id, error }) => {
      useTasksStore().patchTask(task_id, { status: 'failed', error });
    });

    // Import/init progress
    s.on('import.progress', ({ project_id, phase, message, pct }) => {
      console.log(`[import:${project_id}] ${phase}: ${message}`);
    });

    s.on('import.done', ({ project_id, detected }) => {
      useProjectsStore().updateInitStatus(project_id, 'imported');
      useProjectsStore().fetchOne(project_id);
    });

    s.on('import.error', ({ project_id, message }) => {
      useProjectsStore().updateInitStatus(project_id, 'error', message);
    });

    s.on('init.done', ({ project_id }) => {
      useProjectsStore().updateInitStatus(project_id, 'ready');
      useProjectsStore().fetchOne(project_id);
    });

    s.on('manifest.updated', ({ project_id, manifest }) => {
      const mStore = useManifestStore();
      if (mStore.projectId === project_id) mStore.update(manifest);
    });

    // Parallel orchestration (per-plan worktree runs)
    const orchFor = (project_id) => {
      const o = useOrchestrationStore();
      return o.projectId === project_id ? o : null;
    };
    s.on('orchestration.started',         ({ project_id, run })  => orchFor(project_id)?.onStarted(run));
    s.on('orchestration.group.started',   ({ project_id, ...p }) => orchFor(project_id)?.onGroupStarted(p));
    s.on('orchestration.group.log',       ({ project_id, ...p }) => orchFor(project_id)?.onGroupLog(p));
    s.on('orchestration.group.completed', ({ project_id, ...p }) => orchFor(project_id)?.onGroupCompleted(p));
    s.on('orchestration.group.failed',    ({ project_id, ...p }) => orchFor(project_id)?.onGroupFailed(p));
    s.on('orchestration.group.pushed',    ({ project_id, ...p }) => orchFor(project_id)?.onGroupPushed(p));
    s.on('orchestration.completed',       ({ project_id, run })  => orchFor(project_id)?.onCompleted({ run }));

    socket.value = s;
  }

  function subscribe(projectId) {
    if (!socket.value) connect();
    if (!subscribed.value.has(projectId)) {
      subscribed.value.add(projectId);
      socket.value.emit('subscribe', { project_id: projectId });
    }
  }

  function unsubscribe(projectId) {
    subscribed.value.delete(projectId);
    socket.value?.emit('unsubscribe', { project_id: projectId });
  }

  function disconnect() {
    socket.value?.disconnect();
    socket.value = null;
    connected.value = false;
    connecting.value = false;
    subscribed.value.clear();
  }

  return { socket, connected, connecting, subscribed, connect, subscribe, unsubscribe, disconnect };
});
