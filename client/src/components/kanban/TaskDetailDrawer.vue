<template>
  <Drawer :visible="true" @update:visible="v => { if (!v) $emit('close'); }" position="right" :style="{ width: '420px' }">
    <template #header>
      <div>
        <div class="drawer-id">{{ task.id }}</div>
        <div class="drawer-title">{{ task.title }}</div>
      </div>
    </template>

    <div class="drawer-body">
      <div class="drawer-meta">
        <Tag :value="task.status" :severity="statusSeverity" />
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
  </Drawer>
</template>

<script setup>
import { computed, ref, nextTick, watch } from 'vue';
import Drawer from 'primevue/drawer';
import Tag from 'primevue/tag';
import { useProcessStore } from '../../stores/process.js';

const props = defineProps({ task: Object, projectId: String });
defineEmits(['close']);

const proc = useProcessStore();
const logEl = ref(null);
const taskLog = computed(() => proc.taskLogFull(props.task.id));

const statusSeverity = computed(() => {
  const s = props.task.status;
  return {
    pending: 'secondary',
    in_progress: 'warn',
    completed: 'success',
    failed: 'danger',
    blocked: 'warn',
    skipped: 'secondary',
  }[s] || 'secondary';
});

watch(() => taskLog.value.length, () => {
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
});

function fmt(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : '';
}
</script>

<style scoped>
.drawer-id { font-size: 10px; color: var(--jg-text-faint); margin-bottom: 4px; }
.drawer-title { font-size: 13px; font-weight: 600; color: var(--jg-text); }

.drawer-body { display: flex; flex-direction: column; gap: 16px; }
.drawer-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta-time { font-size: 11px; color: var(--jg-text-faint); }

.drawer-section {}
.drawer-section-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--jg-text-faint); margin-bottom: 6px; }
.error-title { color: var(--jg-red); }
.drawer-desc { font-size: 12px; color: var(--jg-text-dim); line-height: 1.6; }
.drawer-file { font-size: 11px; color: var(--jg-text-muted); }
.drawer-deps { font-size: 12px; color: var(--jg-text); }
.drawer-error { font-size: 12px; color: var(--jg-red); }
.drawer-log {
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 10px; font-size: 11px; color: var(--jg-text-muted);
  max-height: 280px; overflow-y: auto;
}
.log-empty { color: var(--jg-text-faint); }
.log-line { line-height: 1.5; }
</style>
