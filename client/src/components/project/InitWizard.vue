<template>
  <div class="init-wizard">
    <div class="form-row">
      <div class="form-group">
        <label>AI Tool</label>
        <Select v-model="form.tool" :options="[
          { label: 'OpenCode', value: 'opencode' },
          { label: 'Claude Code', value: 'claude' },
          { label: 'Jonggrang (Pi)', value: 'jonggrang' },
        ]" optionLabel="label" optionValue="value" fluid />
      </div>
      <div class="form-group">
        <label>Autonomy</label>
        <Select v-model="form.autonomy" :options="[
          { label: 'Full (auto-approve)', value: 'autonomous' },
          { label: 'Balanced (approve edits)', value: 'balanced' },
          { label: 'Supervised (review each task)', value: 'supervised' },
        ]" optionLabel="label" optionValue="value" fluid />
      </div>
    </div>

    <button class="advanced-toggle" @click="showAdvanced = !showAdvanced">
      <i :class="showAdvanced ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
      Advanced
    </button>

    <div v-if="showAdvanced" class="advanced-panel">
      <div class="form-row">
        <div class="form-group">
          <label>Project type</label>
          <Select v-model="form.type" :options="[
            { label: 'API / Backend', value: 'api' },
            { label: 'Web App / Frontend', value: 'web-app' },
            { label: 'CLI Tool', value: 'cli' },
            { label: 'Library', value: 'library' },
            { label: 'Full Stack', value: 'fullstack' },
          ]" optionLabel="label" optionValue="value" placeholder="Choose..." fluid />
        </div>
        <div class="form-group">
          <label>Stack</label>
          <Select v-model="form.stack" :options="[
            { label: 'Node.js / TypeScript', value: 'node-typescript' },
            { label: 'Express / TypeScript', value: 'express-typescript' },
            { label: 'Next.js / TypeScript', value: 'nextjs-typescript' },
            { label: 'Python / FastAPI', value: 'python-fastapi' },
            { label: 'Go', value: 'go' },
            { label: 'Rust', value: 'rust' },
          ]" optionLabel="label" optionValue="value" placeholder="Choose..." fluid />
        </div>
      </div>
      <div class="form-group sandbox-group">
        <label>Execution Environment</label>
        <label class="sandbox-toggle-row">
          <input type="checkbox" v-model="form.sandbox_enabled" />
          <span>Run in Docker sandbox</span>
        </label>
        <input v-if="form.sandbox_enabled" v-model="form.sandbox_image"
          placeholder="orcinus/jonggrang-agent" class="sandbox-image-input" />
        <input v-if="form.sandbox_enabled" v-model="form.sandbox_shell"
          placeholder="/bin/bash" class="sandbox-image-input" style="margin-top:4px" />
      </div>
    </div>

    <div v-if="error" class="error-text">{{ error }}</div>
    <div v-if="initLog.length" class="init-log">
      <div v-for="(l, i) in initLog" :key="i" class="init-log-line">{{ l }}</div>
    </div>

    <div class="wizard-actions">
      <Button label="Cancel" severity="secondary" @click="$emit('cancel')" />
      <Button :disabled="initing" @click="doInit">
        <i class="pi pi-rocket" /> {{ initing ? 'Initializing...' : 'Initialize' }}
      </Button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useProjectsStore } from '../../stores/projects.js';
import { useWsStore } from '../../stores/ws.js';

const props = defineProps({ project: Object, detected: Object });
const emit = defineEmits(['done', 'cancel']);

const projects = useProjectsStore();
const ws = useWsStore();
const initing = ref(false);
const error = ref('');
const initLog = ref([]);
const showAdvanced = ref(false);

const form = ref({
  type: null,
  stack: null,
  tool: 'jonggrang',
  autonomy: 'autonomous',
  sandbox_enabled: false,
  sandbox_image: '',
  sandbox_shell: '',
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
    const payload = { ...form.value };
    if (form.value.sandbox_enabled) {
      payload.sandbox = {
        enabled: true,
        image: form.value.sandbox_image || 'orcinus/jonggrang-agent',
        shell: form.value.sandbox_shell || '/bin/bash',
      };
    }
    await projects.initProject(props.project.id, payload);
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
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 10px; font-size: 11px; color: var(--jg-text-muted);
  max-height: 140px; overflow-y: auto; margin-bottom: 12px;
}
.init-log-line { line-height: 1.5; }

.advanced-toggle {
  display: flex; align-items: center; gap: 6px;
  background: none; border: none; cursor: pointer; padding: 6px 0;
  font-size: 11px; color: var(--jg-text-faint); margin-bottom: 4px;
  transition: color 0.15s;
}
.advanced-toggle:hover { color: var(--jg-text-muted); }
.advanced-toggle .pi { font-size: 10px; }

.advanced-panel { margin-bottom: 4px; }

.sandbox-group { margin-top: 12px; }
.sandbox-toggle-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: 12px; color: var(--jg-text-muted); margin-bottom: 0;
}
.sandbox-toggle-row input[type="checkbox"] { accent-color: var(--jg-green); }
.sandbox-image-input {
  margin-top: 8px; width: 100%; padding: 6px 10px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: inherit; font-size: 12px;
  outline: none;
}
.sandbox-image-input:focus { border-color: var(--jg-green); }
</style>
