<template>
  <div class="log-root">
    <div class="log-toolbar">
      <div class="log-title">Process Logs</div>
      <button class="btn btn--secondary btn--sm" @click="clearDisplay">Clear display</button>
    </div>
    <div class="log-body" ref="logEl">
      <div v-if="!proc.globalLog.length" class="log-empty">No logs yet. Start a plan or work session.</div>
      <div v-for="(entry, i) in proc.globalLog" :key="i" class="log-line" :class="`log-line--${entry.stream || 'stdout'}`">
        <span class="log-seq">[{{ entry.seq ?? i }}]</span>
        <span class="log-text">{{ entry.line }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { useProcessStore } from '../../stores/process.js';

const proc = useProcessStore();
const logEl = ref(null);

watch(() => proc.globalLog.length, () => {
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
});

function clearDisplay() { proc.clearLogs(); }
</script>

<style scoped>
.log-root { display: flex; flex-direction: column; height: 100%; }
.log-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; border-bottom: 1px solid #1e1f2a; flex-shrink: 0;
}
.log-title { font-size: 12px; font-weight: 600; color: #9ca3af; }
.log-body { flex: 1; overflow-y: auto; padding: 12px 16px; font-family: monospace; font-size: 12px; }
.log-empty { color: #2d2f3e; }
.log-line { display: flex; gap: 8px; line-height: 1.6; }
.log-line--stderr .log-text { color: #f87171; }
.log-line--stdout .log-text { color: #9ca3af; }
.log-seq { color: #2d2f3e; flex-shrink: 0; }
.log-text { word-break: break-all; }
</style>
