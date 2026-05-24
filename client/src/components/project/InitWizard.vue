<template>
  <div class="init-wizard">
    <div class="form-row">
      <div class="form-group">
        <label>Project type</label>
        <select v-model="form.type">
          <option value="api">API / Backend</option>
          <option value="web-app">Web App / Frontend</option>
          <option value="cli">CLI Tool</option>
          <option value="library">Library</option>
          <option value="fullstack">Full Stack</option>
        </select>
      </div>
      <div class="form-group">
        <label>Stack</label>
        <select v-model="form.stack">
          <option value="node-typescript">Node.js / TypeScript</option>
          <option value="express-typescript">Express / TypeScript</option>
          <option value="nextjs-typescript">Next.js / TypeScript</option>
          <option value="python-fastapi">Python / FastAPI</option>
          <option value="go">Go</option>
          <option value="rust">Rust</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>AI Tool</label>
        <select v-model="form.tool">
          <option value="opencode">OpenCode</option>
          <option value="claude">Claude Code</option>
          <option value="jonggrang">Jonggrang (Pi)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Autonomy</label>
        <select v-model="form.autonomy">
          <option value="autonomous">Full (auto-approve)</option>
          <option value="balanced">Balanced (approve edits)</option>
          <option value="supervised">Supervised (review each task)</option>
        </select>
      </div>
    </div>

    <div v-if="error" class="error-text">{{ error }}</div>
    <div v-if="initLog.length" class="init-log">
      <div v-for="(l, i) in initLog" :key="i" class="init-log-line">{{ l }}</div>
    </div>

    <div class="wizard-actions">
      <button class="btn btn--secondary" @click="$emit('cancel')">Cancel</button>
      <button class="btn btn--primary" :disabled="initing" @click="doInit">
        {{ initing ? 'Initializing...' : '🚀 Initialize' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { useProjectsStore } from '../../stores/projects.js';
import { useWsStore } from '../../stores/ws.js';

const props = defineProps({ project: Object, detected: Object });
const emit = defineEmits(['done', 'cancel']);

const projects = useProjectsStore();
const ws = useWsStore();
const initing = ref(false);
const error = ref('');
const initLog = ref([]);

const form = ref({
  type: 'api',
  stack: 'node-typescript',
  tool: 'opencode',
  autonomy: 'autonomous',
});

// Pre-fill from detected stack
watch(() => props.detected, (d) => {
  if (d?.stack) form.value.stack = d.stack;
  if (d?.type) form.value.type = d.type;
}, { immediate: true });

onMounted(() => {
  const socket = ws.socket;
  if (!socket) return;
  socket.on('process.log', ({ project_id, line }) => {
    if (project_id !== props.project?.id) return;
    initLog.value.push(line);
  });
  socket.on('init.done', ({ project_id }) => {
    if (project_id !== props.project?.id) return;
    initing.value = false;
    emit('done');
  });
  socket.on('process.exited', ({ project_id, code }) => {
    if (project_id !== props.project?.id) return;
    if (code !== 0) {
      initing.value = false;
      error.value = `Init failed with exit code ${code}`;
    }
  });
});

async function doInit() {
  if (!props.project) return;
  error.value = '';
  initLog.value = [];
  initing.value = true;
  try {
    await projects.initProject(props.project.id, form.value);
  } catch (e) {
    error.value = e.message;
    initing.value = false;
  }
}
</script>

<style scoped>
.init-wizard {}
.wizard-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.init-log {
  background: #0a0b0f; border: 1px solid #1e1f2a; border-radius: 6px;
  padding: 10px; font-family: monospace; font-size: 11px; color: #6b7280;
  max-height: 140px; overflow-y: auto; margin-bottom: 12px;
}
.init-log-line { line-height: 1.5; }
</style>
