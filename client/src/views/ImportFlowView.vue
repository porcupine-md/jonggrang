<template>
  <div class="page">
    <div class="page-header">
      <div>
        <RouterLink to="/" class="back-link"><i class="pi pi-arrow-left" /> Projects</RouterLink>
        <div class="page-title">New Project</div>
      </div>
    </div>

    <div class="wizard-card">
      <!-- Step 1: source type -->
      <div v-if="step === 1">
        <div class="wizard-section-title">How do you want to start?</div>
        <div class="source-options">
          <button
            v-for="opt in sourceOptions" :key="opt.type"
            class="source-option"
            :class="{ 'source-option--active': sourceType === opt.type }"
            @click="sourceType = opt.type"
          >
            <i :class="`pi ${opt.icon} source-icon`" />
            <div class="source-label">{{ opt.label }}</div>
            <div class="source-desc">{{ opt.desc }}</div>
          </button>
        </div>

        <div class="form-group">
          <label>Project name</label>
          <InputText v-model="name" placeholder="my-project" fluid />
        </div>

        <div v-if="sourceType === 'git'" class="form-group">
          <label>Git repository URL</label>
          <InputText v-model="gitUrl" type="url" placeholder="https://github.com/user/repo.git" fluid />
        </div>

        <div v-if="sourceType === 'local'" class="form-group">
          <label>Local folder path</label>
          <InputText v-model="localPath" placeholder="/Users/you/my-project" fluid />
        </div>

        <div v-if="sourceType === 'fresh'" class="form-group">
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" v-model="freshGitInit" style="flex-shrink:0" />
            Initialize git repository
          </label>
        </div>

        <div v-if="importError" class="error-text">{{ importError }}</div>

        <div class="wizard-actions">
          <RouterLink to="/"><Button label="Cancel" severity="secondary" /></RouterLink>
          <Button :disabled="!canNext || importing" @click="doImport">
            <i class="pi pi-cloud-download" /> {{ importing ? 'Importing...' : 'Import' }}
          </Button>
        </div>
      </div>

      <!-- Step 2: importing progress -->
      <div v-else-if="step === 2">
        <div class="wizard-section-title">Importing project...</div>
        <div class="progress-log">
          <div v-for="(msg, i) in progressLog" :key="i" class="progress-line">{{ msg }}</div>
        </div>
      </div>

      <!-- Step 3: init -->
      <div v-else-if="step === 3">
        <div class="wizard-section-title">Initialize Jonggrang</div>
        <div class="detected-info" v-if="detected">
          <Tag :value="`Detected: ${detected.stack} · ${detected.type}`" severity="info" />
        </div>
        <InitWizard :project="currentProject" :detected="detected" @done="onInitDone" @cancel="goHome" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Tag from 'primevue/tag';
import { useProjectsStore } from '../stores/projects.js';
import { useWsStore } from '../stores/ws.js';
import InitWizard from '../components/project/InitWizard.vue';

const router = useRouter();
const projects = useProjectsStore();
const ws = useWsStore();

const step = ref(1);
const sourceType = ref('git');
const name = ref('');
const gitUrl = ref('');
const localPath = ref('');
const freshGitInit = ref(true);
const importing = ref(false);
const importError = ref('');
const progressLog = ref([]);
const detected = ref(null);
const currentProjectId = ref(null);
const currentProject = computed(() => currentProjectId.value ? projects.byId[currentProjectId.value] : null);

const sourceOptions = [
  { type: 'git',   icon: 'pi-link',   label: 'Git Repository', desc: 'Clone from GitHub, GitLab, etc.' },
  { type: 'local', icon: 'pi-folder', label: 'Local Folder',   desc: 'Use an existing project on disk' },
  { type: 'fresh', icon: 'pi-plus',   label: 'Fresh Start',    desc: 'Create a new empty project' },
];

const canNext = computed(() => {
  if (!name.value.trim()) return false;
  if (sourceType.value === 'git' && !gitUrl.value.trim()) return false;
  if (sourceType.value === 'local' && !localPath.value.trim()) return false;
  return true;
});

function buildSource() {
  if (sourceType.value === 'git') return { type: 'git', url: gitUrl.value.trim() };
  if (sourceType.value === 'local') return { type: 'local', path: localPath.value.trim(), link_mode: 'reference' };
  return { type: 'fresh', git_init: freshGitInit.value };
}

async function doImport() {
  importError.value = '';
  importing.value = true;
  try {
    const { id } = await projects.importProject(name.value.trim(), buildSource());
    currentProjectId.value = id;
    step.value = 2;
    progressLog.value = ['Importing...'];

    // Subscribe to project events
    ws.subscribe(id);

    // Listen via socket
    const socket = ws.socket;
    socket.on('import.progress', ({ project_id, message }) => {
      if (project_id !== id) return;
      if (message) progressLog.value.push(message);
    });
    socket.on('import.done', ({ project_id, detected: d }) => {
      if (project_id !== id) return;
      detected.value = d;
      step.value = 3;
    });
    socket.on('import.error', ({ project_id, message }) => {
      if (project_id !== id) return;
      importError.value = message;
      step.value = 1;
    });

    // Timeout fallback — if import was already done before we subscribed
    setTimeout(async () => {
      if (step.value === 2) {
        const p = await projects.fetchOne(id).catch(() => null);
        if (p?.init_status === 'imported') {
          step.value = 3;
        }
      }
    }, 3000);

  } catch (e) {
    importError.value = e.message;
  } finally {
    importing.value = false;
  }
}

function onInitDone() {
  goHome();
}

function goHome() {
  router.push('/');
}
</script>

<style scoped>
.back-link { font-size: 11px; color: var(--jg-text-faint); text-decoration: none; display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.back-link:hover { color: var(--jg-text-muted); }
.wizard-card { max-width: 540px; background: var(--jg-card); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 20px; }
.wizard-section-title { font-size: 13px; font-weight: 600; color: var(--jg-text); margin-bottom: 16px; }

.source-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 20px; }
.source-option {
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 12px; cursor: pointer; text-align: center; transition: all 0.15s; color: inherit;
}
.source-option:hover { border-color: var(--jg-text-faint); background: var(--jg-hover); }
.source-option--active { border-color: var(--jg-green); background: color-mix(in oklch, var(--jg-green) 10%, var(--jg-bg)); }
.source-icon { font-size: 20px; margin-bottom: 6px; color: var(--jg-green); display: block; }
.source-label { font-size: 12px; font-weight: 600; color: var(--jg-text); margin-bottom: 2px; }
.source-desc { font-size: 11px; color: var(--jg-text-faint); }

.wizard-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--jg-border); }

.progress-log {
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 12px; font-size: 11px;
  max-height: 200px; overflow-y: auto; color: var(--jg-text-muted);
}
.progress-line { line-height: 1.6; }
.detected-info { margin-bottom: 16px; }
</style>
