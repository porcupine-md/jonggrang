import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useProcessStore = defineStore('process', () => {
  const running = ref(null); // { command, pid, startedAt }
  const globalLog = ref([]);
  const taskLogs = ref({}); // taskId -> LogEntry[]
  const lastSeq = ref(-1);
  const MAX_LOG = 2000;
  const MAX_TASK_LOG = 500;

  const PLAN_COMMANDS = ['plan', 'plan-revise', 'plan-extend', 'approve'];
  const isRunning = computed(() => !!running.value);
  // Which plan-family op (if any) is running — lets consumers map kind→spinner.
  const planCommand = computed(() =>
    PLAN_COMMANDS.includes(running.value?.command) ? running.value.command : null);
  const isPlanRunning = computed(() => planCommand.value !== null);
  const elapsed = computed(() => {
    if (!running.value) return 0;
    return Date.now() - running.value.startedAt;
  });

  function setRunning(info) {
    running.value = { ...info, startedAt: Date.now() };
  }
  function setExited() { running.value = null; }

  function appendLog(entry) {
    globalLog.value.push(entry);
    if (globalLog.value.length > MAX_LOG) globalLog.value.shift();
    lastSeq.value = Math.max(lastSeq.value, entry.seq ?? 0);
  }

  function appendTaskLog(taskId, entry) {
    if (!taskLogs.value[taskId]) taskLogs.value[taskId] = [];
    taskLogs.value[taskId].push(entry);
    if (taskLogs.value[taskId].length > MAX_TASK_LOG) taskLogs.value[taskId].shift();
  }

  function clearLogs() {
    globalLog.value = [];
    taskLogs.value = {};
    lastSeq.value = -1;
  }

  function taskLogPreview(taskId) {
    const entries = taskLogs.value[taskId];
    return entries?.[entries.length - 1]?.line ?? '';
  }

  function taskLogFull(taskId) { return taskLogs.value[taskId] ?? []; }

  return {
    running, globalLog, taskLogs, lastSeq,
    isRunning, planCommand, isPlanRunning, elapsed,
    setRunning, setExited, appendLog, appendTaskLog, clearLogs,
    taskLogPreview, taskLogFull,
  };
});
