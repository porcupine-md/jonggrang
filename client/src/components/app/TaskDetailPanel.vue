<script setup>
import { PlayIcon, TrashIcon, XIcon } from 'lucide-vue-next';
import { getStatusColor, getStatusLabel } from '../../utils/appUi';

const props = defineProps({
  task: {
    type: Object,
    required: true,
  },
  rawTasks: {
    type: Array,
    default: () => [],
  },
  isRunning: {
    type: Boolean,
    default: false,
  },
});

defineEmits(['close', 'start-task', 'delete-task']);

function dependencyStatus(dep) {
  return props.rawTasks.find(task => task.id === dep)?.status || 'pending';
}
</script>

<template>
  <div class="detail-panel">
    <div class="detail-header">
      <span class="detail-id">{{ task.id }}</span>
      <button class="icon-btn" @click="$emit('close')"><XIcon :size="15" /></button>
    </div>
    <div class="detail-body">
      <div class="detail-title">{{ task.title }}</div>
      <div v-if="task.description && task.description !== task.title" class="detail-desc">{{ task.description }}</div>

      <div class="detail-meta">
        <span class="detail-status" :style="{ color: getStatusColor(task.status) }">
          {{ getStatusLabel(task.status) }}
        </span>
        <span v-if="task.role" class="detail-tag role-tag">{{ task.role }}</span>
        <span v-if="task.skill" class="detail-skill">{{ task.skill }}</span>
        <span v-if="task.priority != null" class="detail-tag">P{{ task.priority }}</span>
      </div>

      <div v-if="task.started_at || task.completed_at" class="detail-section">
        <div class="detail-section-label">TIMING</div>
        <div v-if="task.started_at" class="detail-kv">
          <span class="detail-k">Started</span>
          <span class="detail-v">{{ new Date(task.started_at).toLocaleTimeString() }}</span>
        </div>
        <div v-if="task.completed_at" class="detail-kv">
          <span class="detail-k">Completed</span>
          <span class="detail-v">{{ new Date(task.completed_at).toLocaleTimeString() }}</span>
        </div>
      </div>

      <div v-if="task.files && task.files.length > 0" class="detail-section">
        <div class="detail-section-label">FILES</div>
        <div v-for="file in task.files" :key="file" class="detail-file">{{ file }}</div>
      </div>

      <div v-if="task.blocked_by && task.blocked_by.length > 0" class="detail-section">
        <div class="detail-section-label">DEPENDS ON</div>
        <div v-for="dependency in task.blocked_by" :key="dependency" class="detail-dep">
          <span class="dep-dot" :style="{ background: getStatusColor(dependencyStatus(dependency)) }"></span>
          {{ dependency }}
        </div>
      </div>

      <div v-if="task.error_log && task.error_log.length > 0" class="detail-section">
        <div class="detail-section-label">ERRORS</div>
        <div v-for="(error, index) in task.error_log" :key="index" class="detail-error">{{ error }}</div>
      </div>
    </div>
    <div class="detail-actions">
      <button v-if="task.status === 'pending'" class="btn-primary" @click="$emit('start-task', task.id)" :disabled="isRunning">
        <PlayIcon :size="13" /> Start
      </button>
      <button class="btn-danger" @click="$emit('delete-task', task.id)">
        <TrashIcon :size="13" /> Delete
      </button>
    </div>
  </div>
</template>

<style scoped>
.detail-panel {
  width: 260px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.detail-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

.detail-body {
  flex: 1;
  padding: 14px 12px;
  overflow-y: auto;
}

.detail-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
  margin-bottom: 8px;
}

.detail-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 10px;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 12px;
}

.detail-status {
  font-size: 11px;
  font-weight: 600;
}

.detail-skill {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.12);
  color: var(--purple);
}

.detail-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-elevated);
  color: var(--text-muted);
}

.role-tag {
  background: rgba(56, 189, 248, 0.1);
  color: var(--accent);
}

.detail-section {
  margin-bottom: 12px;
}

.detail-section-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  color: var(--text-muted);
  text-transform: uppercase;
  margin-bottom: 5px;
}

.detail-file {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  padding: 2px 0;
  word-break: break-all;
}

.detail-dep {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  padding: 2px 0;
}

.dep-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.detail-kv {
  display: flex;
  gap: 6px;
  font-size: 11px;
  padding: 2px 0;
}

.detail-k {
  color: var(--text-muted);
  min-width: 60px;
}

.detail-v {
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.detail-error {
  font-size: 11px;
  color: var(--red);
  font-family: var(--font-mono);
  padding: 3px 6px;
  background: var(--red-muted);
  border-radius: 3px;
  margin-bottom: 3px;
  word-break: break-all;
}

.detail-actions {
  display: flex;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.btn-primary,
.btn-danger {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.15s;
}

.btn-primary {
  background: var(--green);
  color: #000;
}

.btn-primary:hover {
  background: #0ea271;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-danger {
  background: var(--red-muted);
  color: var(--red);
}

.btn-danger:hover {
  background: rgba(239, 68, 68, 0.2);
}
</style>
