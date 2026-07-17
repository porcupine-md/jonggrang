<template>
  <div class="changelog-view">
    <div class="cl-header">
      <span class="cl-title">Changelog</span>
      <span class="cl-hint">Agents append learnings here after each task</span>
    </div>
    <div v-if="loading" class="cl-empty">Loading...</div>
    <div v-else-if="!exists" class="cl-empty">
      No changelog yet. Run a work session to generate entries.
    </div>
    <div v-else class="cl-body" ref="bodyEl" v-html="rendered"></div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useWsStore } from '../stores/ws.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const ws = useWsStore();

const content = ref('');
const exists = ref(false);
const loading = ref(true);
const bodyEl = ref(null);

const rendered = computed(() => {
  try { return DOMPurify.sanitize(marked.parse(content.value || '')); }
  catch { return DOMPurify.sanitize(content.value || ''); }
});

function scrollToBottom() {
  nextTick(() => {
    if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
  });
}

async function load() {
  loading.value = true;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/progress`);
    if (!res.ok) return;
    const data = await res.json();
    content.value = data.content || '';
    exists.value = !!(data.exists || data.content?.length > 0);
    scrollToBottom();
  } catch {} finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  const socket = ws.socket;
  if (socket) {
    socket.on('progress.update', ({ project_id, content: c }) => {
      if (project_id !== projectId.value) return;
      content.value = c;
      exists.value = true;
      scrollToBottom();
    });
  }
});

watch(projectId, (id) => { if (id) load(); });
</script>

<style scoped>
.changelog-view {
  display: flex; flex-direction: column; height: 100%; overflow: hidden;
}

.cl-header {
  display: flex; align-items: baseline; gap: 12px;
  padding: 10px 20px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.cl-title { font-size: 12px; font-weight: 600; color: var(--jg-text); }
.cl-hint { font-size: 11px; color: var(--jg-text-faint); }

.cl-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--jg-text-faint);
}

.cl-body {
  flex: 1; overflow-y: auto; padding: 20px;
  font-size: 13px; color: var(--jg-text); line-height: 1.7;
}
.cl-body :deep(h1) {
  font-size: 13px; color: var(--jg-green); border-bottom: 1px solid var(--jg-border);
  padding-bottom: 6px; margin: 0 0 12px;
}
.cl-body :deep(h2) { font-size: 13px; color: var(--jg-cyan); margin: 16px 0 6px; }
.cl-body :deep(h3) { font-size: 12px; color: var(--jg-text-dim); margin: 12px 0 4px; }
.cl-body :deep(p) { margin-bottom: 8px; }
.cl-body :deep(ul), .cl-body :deep(ol) { padding-left: 20px; margin-bottom: 8px; }
.cl-body :deep(li) { margin-bottom: 3px; }
.cl-body :deep(code) { background: var(--jg-hover); padding: 2px 5px; border-radius: 3px; font-size: 12px; color: var(--jg-green); }
.cl-body :deep(pre) { background: var(--jg-card); padding: 12px; border-radius: var(--radius); overflow-x: auto; margin-bottom: 10px; }
.cl-body :deep(hr) { border: none; border-top: 1px solid var(--jg-border); margin: 14px 0; }
.cl-body :deep(blockquote) { border-left: 3px solid var(--jg-border); padding-left: 12px; color: var(--jg-text-muted); margin: 8px 0; }
</style>
