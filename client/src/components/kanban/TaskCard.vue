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
    <div v-if="preview && task.status === 'in_progress'" class="card-preview"><i class="pi pi-arrow-right" style="font-size:9px" /> {{ preview }}</div>
    <div v-if="task.status === 'failed' && task.error" class="card-error">! {{ task.error }}</div>
    <div v-if="task.status === 'blocked'" class="card-blocked-actions" @click.stop>
      <Button size="small" severity="secondary" :disabled="resuming" @click="resumeTask">
        <i class="pi pi-refresh" /> {{ resuming ? '...' : 'Resume' }}
      </Button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import Button from 'primevue/button';
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
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 10px; cursor: pointer; transition: border-color 0.15s;
}
.task-card:hover { border-color: var(--jg-text-faint); }
.task-card--in_progress { border-color: color-mix(in oklch, var(--jg-orange) 40%, transparent); }
.task-card--completed   { border-color: color-mix(in oklch, var(--jg-green) 35%, transparent); opacity: 0.85; }
.task-card--failed      { border-color: color-mix(in oklch, var(--jg-red) 40%, transparent); }
.task-card--blocked     { border-color: color-mix(in oklch, var(--jg-orange) 40%, transparent); }

.card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.task-id { font-size: 10px; color: var(--jg-text-faint); }
.card-right { display: flex; align-items: center; gap: 6px; }
.task-elapsed { font-size: 10px; color: var(--jg-text-faint); }

.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot--pending     { background: var(--jg-text-faint); }
.dot--in_progress { background: var(--jg-orange); animation: pulse 1s infinite; }
.dot--completed   { background: var(--jg-green); }
.dot--blocked     { background: var(--jg-orange); }
.dot--failed      { background: var(--jg-red); }
.dot--skipped     { background: var(--jg-text-faint); }

@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }

.card-title { font-size: 12px; color: var(--jg-text); line-height: 1.4; }
.card-files { font-size: 10px; color: var(--jg-text-faint); margin-top: 4px; }
.card-preview { font-size: 10px; color: var(--jg-text-muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 3px; }
.card-error { font-size: 10px; color: var(--jg-red); margin-top: 4px; }
.card-blocked-actions { margin-top: 8px; }
</style>
