<template>
  <div class="init-wizard">
    <div class="form-row">
      <div class="form-group">
        <label>AI Tool</label>
        <Select v-model="form.tool" :options="[
          { label: 'OpenCode', value: 'opencode' },
          { label: 'Claude Code', value: 'claude' },
          { label: 'OpenAI Codex', value: 'codex' },
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

    <div class="form-row">
      <div class="form-group">
        <label>Code editor</label>
        <Select v-model="form.code_editor" :options="[
          { label: 'Off', value: 'off' },
          { label: 'Lite (file explorer + editor)', value: 'lite' },
          { label: 'Full (VS Code server)', value: 'full' },
        ]" optionLabel="label" optionValue="value" fluid />
      </div>
      <div class="form-group" />
    </div>

    <div class="sandbox-config" :class="{ 'sandbox-config--disabled': !form.sandbox_enabled }">
      <label class="sandbox-toggle-row">
        <input type="checkbox" v-model="form.sandbox_enabled" />
        <span>Run in Docker sandbox</span>
      </label>
      <div class="sandbox-fields">
        <div class="sandbox-field">
          <label class="sandbox-field-label">Image</label>
          <input v-model="form.sandbox_image" :disabled="!form.sandbox_enabled"
            :placeholder="globalSbx.image || 'ghcr.io/porcupine-md/jonggrang-agent'" class="sandbox-input" />
        </div>
        <div class="sandbox-field">
          <label class="sandbox-field-label">Shell</label>
          <input v-model="form.sandbox_shell" :disabled="!form.sandbox_enabled"
            :placeholder="globalSbx.shell || '/bin/bash'" class="sandbox-input" />
        </div>
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
import { ref, reactive, onMounted, watch } from 'vue';
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
const globalSbx = reactive({ image: '', shell: '' });

const form = ref({
  type: null,
  stack: null,
  tool: 'jonggrang',
  autonomy: 'autonomous',
  code_editor: 'lite',
  sandbox_enabled: true,
  sandbox_image: '',
  sandbox_shell: '',
});

// Pre-fill from detected stack
watch(() => props.detected, (d) => {
  if (d?.stack) form.value.stack = d.stack;
  if (d?.type) form.value.type = d.type;
}, { immediate: true });

onMounted(async () => {
  try {
    const res = await fetch('/api/settings/sandbox');
    if (res.ok) { const d = await res.json(); globalSbx.image = d.image || ''; globalSbx.shell = d.shell || ''; }
  } catch {}
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
    const payload = { ...form.value, code_editor: form.value.code_editor };
    if (form.value.sandbox_enabled) {
      payload.sandbox = { enabled: true, image: form.value.sandbox_image || null, shell: form.value.sandbox_shell || null };
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

.sandbox-config {
  border: 1px solid var(--jg-border); padding: 10px 12px;
  display: flex; flex-direction: column; gap: 10px;
  margin: 4px 0; transition: opacity 0.15s;
}
.sandbox-config--disabled { opacity: 0.45; }
.sandbox-toggle-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: 12px; color: var(--jg-text-muted);
}
.sandbox-toggle-row input[type="checkbox"] { accent-color: var(--jg-green); }
.sandbox-fields { display: flex; gap: 10px; }
.sandbox-field { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.sandbox-field-label { font-size: 10px; color: var(--jg-text-faint); text-transform: uppercase; letter-spacing: 0.06em; }
.sandbox-input {
  width: 100%; padding: 5px 8px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: inherit; font-size: 11px; outline: none;
}
.sandbox-input:focus { border-color: var(--jg-green); }
.sandbox-input:disabled { cursor: not-allowed; }
</style>
