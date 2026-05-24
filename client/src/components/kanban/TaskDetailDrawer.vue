<template>
  <div class="drawer-overlay" @click.self="$emit('close')">
    <div class="drawer">
      <div class="drawer-header">
        <div>
          <div class="drawer-id">{{ task.id }}</div>
          <div class="drawer-title">{{ task.title }}</div>
        </div>
        <button class="drawer-close" @click="$emit('close')">✕</button>
      </div>

      <div class="drawer-body">
        <div class="drawer-meta">
          <span class="badge" :class="`badge--${task.status === 'in_progress' ? 'working' : task.status}`">
            {{ task.status }}
          </span>
          <span v-if="task.started_at" class="meta-time">Started: {{ fmt(task.started_at) }}</span>
          <span v-if="task.completed_at" class="meta-time">Done: {{ fmt(task.completed_at) }}</span>
          <span v-if="task.duration_ms" class="meta-time">{{ Math.round(task.duration_ms/1000) }}s</span>
        </div>

        <div v-if="task.description" class="drawer-section">
          <div class="drawer-section-title">Description</div>
          <div class="drawer-desc">{{ task.description }}</div>
        </div>

        <div v-if="task.files?.length" class="drawer-section">
          <div class="drawer-section-title">Files</div>
          <div v-for="f in task.files" :key="f" class="drawer-file">{{ f }}</div>
        </div>

        <div v-if="task.blocked_by?.length" class="drawer-section">
          <div class="drawer-section-title">Blocked by</div>
          <div class="drawer-deps">{{ task.blocked_by.join(', ') }}</div>
        </div>

        <div v-if="task.error" class="drawer-section">
          <div class="drawer-section-title error-title">Error</div>
          <div class="drawer-error">{{ task.error }}</div>
        </div>

        <div class="drawer-section">
          <div class="drawer-section-title">Logs</div>
          <div class="drawer-log" ref="logEl">
            <div v-if="!taskLog.length" class="log-empty">No logs for this task</div>
            <div v-for="(entry, i) in taskLog" :key="i" class="log-line">{{ entry.line }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, nextTick, watch } from 'vue';
import { useProcessStore } from '../../stores/process.js';

const props = defineProps({ task: Object, projectId: String });
defineEmits(['close']);

const proc = useProcessStore();
const logEl = ref(null);
const taskLog = computed(() => proc.taskLogFull(props.task.id));

watch(() => taskLog.value.length, () => {
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
});

function fmt(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : '';
}
</script>

<style scoped>
.drawer-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 50;
  display: flex; justify-content: flex-end;
}
.drawer {
  width: 420px; background: #111218; border-left: 1px solid #2d2f3e;
  display: flex; flex-direction: column; overflow: hidden;
  animation: slideIn 0.2s ease;
}
@keyframes slideIn { from { transform: translateX(100%); } }

.drawer-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 16px; border-bottom: 1px solid #1e1f2a; flex-shrink: 0;
}
.drawer-id { font-size: 11px; font-family: monospace; color: #6b7280; margin-bottom: 4px; }
.drawer-title { font-size: 14px; font-weight: 600; color: #f4f4f5; }
.drawer-close { background: none; border: none; color: #6b7280; cursor: pointer; font-size: 16px; padding: 0; }
.drawer-close:hover { color: #e4e4e7; }

.drawer-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.drawer-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta-time { font-size: 11px; color: #6b7280; }

.drawer-section {}
.drawer-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 6px; }
.error-title { color: #ef4444; }
.drawer-desc { font-size: 12px; color: #9ca3af; line-height: 1.6; }
.drawer-file { font-size: 11px; font-family: monospace; color: #6b7280; }
.drawer-deps { font-size: 12px; color: #9ca3af; }
.drawer-error { font-size: 12px; color: #ef4444; font-family: monospace; }
.drawer-log {
  background: #0a0b0f; border: 1px solid #1e1f2a; border-radius: 6px;
  padding: 10px; font-family: monospace; font-size: 11px; color: #6b7280;
  max-height: 280px; overflow-y: auto;
}
.log-empty { color: #2d2f3e; }
.log-line { line-height: 1.5; }
</style>
