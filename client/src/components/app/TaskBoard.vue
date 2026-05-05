<script setup>
import { PlayIcon, PlusIcon, XIcon } from 'lucide-vue-next';
import { getStatusColor, getStatusLabel } from '../../utils/appUi';

defineProps({
  columns: {
    type: Array,
    required: true,
  },
  selectedTaskId: {
    type: String,
    default: null,
  },
  isRunning: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  'update-status',
  'select-task',
  'start-task',
  'delete-task',
  'open-new-task',
]);

let draggedTask = null;

function handleDragStart(event, task) {
  draggedTask = task;
  event.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function resetDragState() {
  draggedTask = null;
}

function handleDrop(event, status) {
  event.preventDefault();
  if (draggedTask && draggedTask.status !== status) {
    emit('update-status', draggedTask.id, status);
  }
  resetDragState();
}
</script>

<template>
  <div class="kanban">
    <div
      v-for="col in columns"
      :key="col.key"
      class="kanban-col"
      @dragover="handleDragOver"
      @drop="handleDrop($event, col.key)"
    >
      <div class="col-header">
        <span class="col-label">{{ col.label }}</span>
        <span v-if="col.count > 0" class="col-count">{{ col.count }}</span>
      </div>
      <div class="col-body">
        <div
          v-for="task in col.tasks"
          :key="task.id"
          :class="['task-card', { selected: selectedTaskId === task.id, running: task.status === 'in_progress' && isRunning }]"
          draggable="true"
          @dragstart="handleDragStart($event, task)"
          @dragend="resetDragState"
          @click="$emit('select-task', task)"
        >
          <div class="card-bar" :style="{ background: getStatusColor(task.status) }"></div>
          <div class="card-body">
            <div class="card-title">{{ task.title }}</div>
            <div v-if="task.description && task.description !== task.title" class="card-desc">{{ task.description }}</div>
            <div class="card-footer">
              <span class="card-id">{{ task.id }}</span>
              <span class="card-status" :style="{ color: getStatusColor(task.status) }">{{ getStatusLabel(task.status) }}</span>
              <div class="card-actions">
                <button
                  v-if="task.status === 'pending'"
                  class="card-btn"
                  :disabled="isRunning"
                  @click.stop="$emit('start-task', task.id)"
                >
                  <PlayIcon :size="11" />
                </button>
                <button class="card-btn danger" @click.stop="$emit('delete-task', task.id)">
                  <XIcon :size="11" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <button v-if="col.key === 'pending'" class="add-btn" @click="$emit('open-new-task')">
          <PlusIcon :size="14" />New task
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.kanban {
  display: flex;
  flex: 1;
  gap: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.kanban-col {
  flex: 1;
  min-width: 200px;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
}

.kanban-col:last-child {
  border-right: none;
  flex: 1;
  max-width: none;
}

.col-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.col-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  text-transform: uppercase;
}

.col-count {
  font-size: 11px;
  font-weight: 700;
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  padding: 0 4px;
}

.col-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 10px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.col-body::-webkit-scrollbar {
  width: 4px;
}

.col-body::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 2px;
}

.task-card {
  display: flex;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.12s;
  overflow: hidden;
  flex-shrink: 0;
}

.task-card:hover {
  background: var(--bg-card-hover);
  border-color: var(--border-default);
}

.task-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.task-card.running {
  border-color: rgba(59, 130, 246, 0.4);
  animation: pulse 2s infinite;
}

.card-bar {
  width: 3px;
  flex-shrink: 0;
}

.card-body {
  flex: 1;
  padding: 10px 12px;
  min-width: 0;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  margin-bottom: 3px;
  color: var(--text-primary);
}

.card-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin-bottom: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-id {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  flex: 1;
}

.card-status {
  font-size: 11px;
  font-weight: 600;
}

.card-actions {
  display: flex;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.15s;
}

.task-card:hover .card-actions {
  opacity: 1;
}

.card-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: none;
  background: var(--bg-elevated);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
}

.card-btn:hover {
  background: var(--bg-modal);
  color: var(--text-secondary);
}

.card-btn.danger:hover {
  color: var(--red);
}

.card-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.add-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  margin: 2px 0 10px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.12s;
  width: 100%;
}

.add-btn:hover {
  border-color: var(--border-default);
  color: var(--text-secondary);
}

@keyframes pulse {
  0%,
  100% { box-shadow: none; }
  50% { box-shadow: 0 0 12px 2px rgba(59, 130, 246, 0.1); }
}
</style>
