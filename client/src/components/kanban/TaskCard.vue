<template>
  <div class="task-card" :class="`task-card--${task.status}`" @click="$emit('click')">
    <div class="card-head">
      <span class="task-id">{{ task.id }}</span>
      <div class="card-right">
        <span v-if="elapsed && task.status === 'in_progress'" class="task-elapsed">{{ elapsed }}</span>
        <span class="status-dot" :class="`dot--${task.status}`" :title="task.status"></span>
      </div>
    </div>
    <div class="card-title">{{ task.title }}</div>
    <div v-if="task.files?.length" class="card-files">
      {{ task.files[0] }}{{ task.files.length > 1 ? ` +${task.files.length - 1}` : '' }}
    </div>
    <div v-if="preview && task.status === 'in_progress'" class="card-preview">↳ {{ preview }}</div>
    <div v-if="task.status === 'failed' && task.error" class="card-error">! {{ task.error }}</div>
    <div v-if="task.status === 'blocked'" class="card-blocked-actions" @click.stop>
      <button class="btn-resume" :disabled="resuming" @click="resumeTask">
        {{ resuming ? '...' : '↺ Resume' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useProcessStore } from '../../stores/process.js';

const props = defineProps({ task: Object });
defineEmits(['click']);

const route = useRoute();
const resuming = ref(false);

async function resumeTask() {
  resuming.value = true;
  try {
    await fetch(`/api/projects/${route.params.id}/work`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: props.task.id }),
    });
  } catch {}
  resuming.value = false;
}

const proc = useProcessStore();
const now = ref(Date.now());
let timer;

watch(() => props.task.status, (s) => {
  if (s === 'in_progress' && !timer) {
    timer = setInterval(() => { now.value = Date.now(); }, 1000);
  } else if (s !== 'in_progress' && timer) {
    clearInterval(timer); timer = null;
  }
}, { immediate: true });

onUnmounted(() => { if (timer) clearInterval(timer); });

const elapsed = computed(() => {
  if (!props.task.started_at) return null;
  const s = Math.floor((now.value - new Date(props.task.started_at).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
});

const preview = computed(() => proc.taskLogPreview(props.task.id));
</script>

<style scoped>
.task-card {
  background: #111218; border: 1px solid #1e1f2a; border-radius: 6px;
  padding: 10px; cursor: pointer; transition: border-color 0.15s;
}
.task-card:hover { border-color: #4b5563; }
.task-card--in_progress { border-color: #92400e; }
.task-card--completed   { border-color: #065f46; opacity: 0.8; }
.task-card--failed      { border-color: #7f1d1d; }
.task-card--blocked     { border-color: #78350f; }

.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.task-id { font-size: 10px; font-family: monospace; color: #4b5563; }
.card-right { display: flex; align-items: center; gap: 6px; }
.task-elapsed { font-size: 10px; color: #6b7280; }

.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot--pending     { background: #4b5563; }
.dot--in_progress { background: #f59e0b; animation: pulse 1s infinite; }
.dot--completed   { background: #10b981; }
.dot--blocked     { background: #f97316; }
.dot--failed      { background: #ef4444; }
.dot--skipped     { background: #6b7280; }

@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }

.card-title { font-size: 12px; color: #d1d5db; line-height: 1.4; }
.card-files { font-size: 10px; color: #4b5563; font-family: monospace; margin-top: 4px; }
.card-preview { font-size: 10px; color: #6b7280; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-error { font-size: 10px; color: #ef4444; margin-top: 4px; }
.card-blocked-actions { margin-top: 8px; }
.btn-resume {
  font-size: 10px; padding: 3px 10px; border-radius: 4px;
  background: #1e1f2a; border: 1px solid #4b5563; color: #9ca3af;
  cursor: pointer; transition: all 0.15s;
}
.btn-resume:hover:not(:disabled) { background: #2d2f3e; color: #e4e4e7; border-color: #6b7280; }
.btn-resume:disabled { opacity: 0.5; cursor: default; }
</style>
