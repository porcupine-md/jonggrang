import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io } from 'socket.io-client';
import { useProjectsStore } from './projects.js';
import { useTasksStore } from './tasks.js';
import { useProcessStore } from './process.js';

export const useWsStore = defineStore('ws', () => {
  const socket = ref(null);
  const connected = ref(false);
  const subscribed = ref(new Set());

  function connect() {
    if (socket.value?.connected) return;

    const s = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

    s.on('connect', () => { connected.value = true; });
    s.on('disconnect', () => { connected.value = false; });

    // Multi-project events
    s.on('subscribed', ({ project_id, snapshot }) => {
      const projects = useProjectsStore();
      const tasks = useTasksStore();
      const proc = useProcessStore();
      if (snapshot) {
        if (snapshot.state) projects.updateDerivedState(project_id, snapshot.state);
        if (snapshot.tasks) tasks.replaceAll(snapshot.tasks);
        if (snapshot.process) proc.setRunning(snapshot.process);
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
    subscribed.value.clear();
  }

  return { socket, connected, subscribed, connect, subscribe, unsubscribe, disconnect };
});
