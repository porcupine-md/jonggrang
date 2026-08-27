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
        <div v-if="pickupHint" class="pickup-hint">
          <i class="pi pi-arrow-right" /> New project from issue <strong>{{ pickupHint }}</strong> — name &amp; git URL pre-filled.
        </div>
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

        <template v-if="sourceType === 'device'">
          <div class="form-group">
            <label>Device</label>
            <select v-model="deviceId" class="device-select">
              <option value="" disabled>{{ devices.length ? 'Pick a registered device' : 'No devices registered yet' }}</option>
              <option v-for="d in devices" :key="d.id" :value="d.id" :disabled="!d.online">
                {{ d.label }} — {{ d.online ? 'tunnel up' : 'tunnel down' }}{{ d.workdir ? ` · ${d.workdir}` : '' }}
              </option>
            </select>
            <div v-if="!devices.length" class="device-hint">
              Register one from the machine itself: <code>jonggrang device register --server &lt;this-host&gt;</code>, then <code>jonggrang tunnel up</code>.
            </div>
            <div v-else-if="pickedDevice && !pickedDevice.online" class="device-hint">
              That device's tunnel is down — run <code>jonggrang tunnel up</code> on it first.
            </div>
          </div>
          <div class="form-group">
            <label>Path on the device</label>
            <InputText v-model="devicePath" placeholder="/Users/you/my-app" fluid />
            <div class="device-hint">Nothing is copied here — this is where the code already lives.</div>
          </div>
        </template>

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
import { useIssuesStore } from '../stores/issues.js';
import { usePickupStore } from '../stores/pickup.js';
import InitWizard from '../components/project/InitWizard.vue';

const router = useRouter();
const projects = useProjectsStore();
const ws = useWsStore();
const issues = useIssuesStore();
const pickup = usePickupStore();

const step = ref(1);
const sourceType = ref('git');
const name = ref('');
const gitUrl = ref('');
const localPath = ref('');
const deviceId = ref('');
const devicePath = ref('');
const devices = ref([]);
const pickedDevice = computed(() => devices.value.find(d => d.id === deviceId.value) || null);
const freshGitInit = ref(true);
const importing = ref(false);
const importError = ref('');
const progressLog = ref([]);
const detected = ref(null);
const currentProjectId = ref(null);
const currentProject = computed(() => currentProjectId.value ? projects.byId[currentProjectId.value] : null);
const pickupHint = ref(null);

// SSH clone URL for a provider/repo (github.com / gitlab.com; handles nested
// GitLab group paths).
function sshUrlFor(provider, repo) {
  const host = provider === 'gitlab' ? 'gitlab.com' : 'github.com';
  return `git@${host}:${repo}.git`;
}

// Arrived from an issue "Pickup → New Project": pre-fill the wizard (name +
// SSH git URL) from the source repo. We peek (not take) the pending pickup so
// onInitDone can still finalize it against the created project.
onMounted(() => {
  loadDevices();
  const pend = pickup.pending;
  if (pend && pend.repo) {
    sourceType.value = 'git';
    name.value = pend.repo.split('/').pop();
    gitUrl.value = sshUrlFor(pend.provider, pend.repo);
    pickupHint.value = `${pend.provider}:${pend.repo}#${pend.number}`;
  }
});

const sourceOptions = [
  { type: 'git',   icon: 'pi-link',   label: 'Git Repository', desc: 'Clone from GitHub, GitLab, etc.' },
  { type: 'local', icon: 'pi-folder', label: 'Local Folder',   desc: 'Use an existing project on disk' },
  { type: 'fresh', icon: 'pi-plus',   label: 'Fresh Start',    desc: 'Create a new empty project' },
  { type: 'device', icon: 'pi-desktop', label: 'On a Device',    desc: 'Code stays on your machine, over its tunnel' },
];

const canNext = computed(() => {
  if (!name.value.trim()) return false;
  if (sourceType.value === 'git' && !gitUrl.value.trim()) return false;
  if (sourceType.value === 'local' && !localPath.value.trim()) return false;
  // A device whose tunnel is down cannot be reached, so importing against it
  // would only produce a project that fails on first use.
  if (sourceType.value === 'device') {
    if (!deviceId.value || !devicePath.value.trim()) return false;
    if (!pickedDevice.value?.online) return false;
  }
  return true;
});

// The picker only lists what this server knows about, and marks which tunnels
// are up — an offline device can be seen but not chosen.
async function loadDevices() {
  try {
    const res = await fetch('/api/devices');
    if (!res.ok) return;
    devices.value = (await res.json()).devices || [];
  } catch { /* the option stays visible and says none are registered */ }
}

function buildSource() {
  if (sourceType.value === 'git') return { type: 'git', url: gitUrl.value.trim() };
  if (sourceType.value === 'local') return { type: 'local', path: localPath.value.trim(), link_mode: 'reference' };
  if (sourceType.value === 'device') return { type: 'device', device_id: deviceId.value, path: devicePath.value.trim() };
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
      // Backend deleted the project — purge from local store too
      projects.list = projects.list.filter(p => p.id !== id);
      ws.unsubscribe(id);
      currentProjectId.value = null;
      importError.value = message;
      step.value = 1;
      importing.value = false;
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

async function onInitDone() {
  // If we arrived here from an issue "Pickup → New Project", finalize the
  // pickup against the freshly created project and open its pre-filled plan form.
  const pend = pickup.takePending();
  if (pend && currentProjectId.value) {
    try {
      const res = await issues.pickup(pend.provider, pend.repo, pend.number, currentProjectId.value);
      pickup.setPrefill({ projectId: currentProjectId.value, description: res.description, source: res.source });
      router.push(`/projects/${currentProjectId.value}/plan`);
      return;
    } catch {
      // Pickup failed — fall through to the normal home navigation.
    }
  }
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
.device-select {
  width: 100%; padding: 8px 10px; font: inherit; font-size: 12px;
  color: var(--jg-text); background: var(--jg-card);
  border: 1px solid var(--jg-border);
}
.device-hint { font-size: 10px; color: var(--jg-text-muted); margin-top: 5px; line-height: 1.5; }
.device-hint code { font-size: 10px; }
.pickup-hint { font-size: 12px; color: var(--jg-green); background: color-mix(in oklch, var(--jg-green) 10%, transparent); border: 1px solid color-mix(in oklch, var(--jg-green) 30%, transparent); border-radius: var(--radius); padding: 8px 10px; margin-bottom: 16px; display: flex; align-items: center; gap: 6px; }
.pickup-hint strong { font-family: var(--font-mono); }
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
.wizard-actions :deep(.p-button) { padding-block: 9px !important; min-height: 36px; }

.progress-log {
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 12px; font-size: 11px;
  max-height: 200px; overflow-y: auto; color: var(--jg-text-muted);
}
.progress-line { line-height: 1.6; }
.detected-info { margin-bottom: 16px; }
</style>
