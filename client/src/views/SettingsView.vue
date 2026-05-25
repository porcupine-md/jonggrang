<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Settings</div>
        <div class="page-subtitle">Configure your Jonggrang workspace</div>
      </div>
    </div>

    <!-- Appearance -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-palette" /> Appearance</div>
      <div class="form-group">
        <label>Theme</label>
        <SelectButton
          v-model="themeMode"
          :options="themeModes"
          optionLabel="label"
          optionValue="value"
          @change="onThemeChange"
        >
          <template #option="{ option }">
            <i :class="option.icon" style="margin-right:6px" />{{ option.label }}
          </template>
        </SelectButton>
        <p class="hint">Changes take effect immediately. Default is Night.</p>
      </div>
    </div>

    <!-- Workspace -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-folder-open" /> Workspace</div>
      <div class="form-group">
        <label>Workspace path</label>
        <div class="input-row">
          <InputText v-model="workspacePath" placeholder="/Users/you/.jonggrang/workspace" style="flex:1" />
          <Button :disabled="saving" @click="saveWorkspace" :icon="saving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="saving ? 'Saving…' : 'Save'" />
        </div>
        <div v-if="saveError" class="error-text"><i class="pi pi-times-circle" /> {{ saveError }}</div>
        <div v-if="saveOk" class="ok-text"><i class="pi pi-check-circle" /> Saved!</div>
        <p class="hint">Projects are stored here when importing from git or creating fresh projects.</p>
      </div>
    </div>

    <!-- About -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-info-circle" /> About</div>
      <div class="about-row"><span>Jonggrang Web</span><span class="about-val">Multi-project wrapper</span></div>
      <div class="about-row"><span>API</span><span class="about-val">Express + Socket.io</span></div>
      <div class="about-row"><span>UI</span><span class="about-val">Vue 3 + PrimeVue 4 (Aura)</span></div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import { useWorkspaceStore } from '../stores/workspace.js';
import { useTheme } from '../composables/useTheme.js';

const workspace = useWorkspaceStore();
const { mode: themeMode, setMode } = useTheme();

const themeModes = [
  { label: 'Night', value: 'night', icon: 'pi pi-moon' },
  { label: 'Light', value: 'light', icon: 'pi pi-sun' },
  { label: 'System', value: 'system', icon: 'pi pi-desktop' },
];

function onThemeChange(e) {
  setMode(e.value);
}

const workspacePath = ref('');
const saving = ref(false);
const saveError = ref('');
const saveOk = ref(false);

onMounted(async () => {
  await workspace.fetch();
  workspacePath.value = workspace.path;
});

async function saveWorkspace() {
  saving.value = true;
  saveError.value = '';
  saveOk.value = false;
  try {
    await workspace.update(workspacePath.value);
    saveOk.value = true;
    setTimeout(() => { saveOk.value = false; }, 2000);
  } catch (e) {
    saveError.value = e.message;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.settings-card {
  max-width: 540px; margin-bottom: 12px;
  background: var(--jg-card);
  border: 1px solid var(--jg-border);
  border-radius: var(--radius); padding: 20px;
}
.card-title {
  font-size: 11px; font-weight: 600;
  color: var(--jg-text-muted);
  margin-bottom: 16px;
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 6px;
}
.input-row { display: flex; gap: 8px; }
.hint { font-size: 11px; color: var(--jg-text-faint); margin-top: 8px; }
.ok-text { color: var(--jg-green); font-size: 12px; margin-top: 4px; display: flex; align-items: center; gap: 4px; }
.about-row {
  display: flex; justify-content: space-between;
  font-size: 12px; color: var(--jg-text-muted);
  padding: 6px 0; border-bottom: 1px solid var(--jg-border);
}
.about-row:last-child { border-bottom: none; }
.about-val { color: var(--jg-text); font-size: 12px; }
</style>
