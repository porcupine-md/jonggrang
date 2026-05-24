<template>
  <div class="page">
    <div class="page-header">
      <div class="page-title">Settings</div>
    </div>

    <div class="settings-section card">
      <div class="section-title">Workspace</div>
      <div class="form-group">
        <label>Workspace path</label>
        <div class="input-row">
          <input v-model="workspacePath" type="text" placeholder="/Users/you/.jonggrang/workspace" />
          <button class="btn btn--primary" :disabled="saving" @click="saveWorkspace">
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>
        <div v-if="saveError" class="error-text">{{ saveError }}</div>
        <div v-if="saveOk" class="ok-text">Saved!</div>
        <p class="hint">Projects are stored here when importing from git or creating fresh projects.</p>
      </div>
    </div>

    <div class="settings-section card">
      <div class="section-title">About</div>
      <div class="about-row">
        <span>Jonggrang Web</span>
        <span class="about-version">Multi-project wrapper</span>
      </div>
      <div class="about-row">
        <span>API</span>
        <span class="about-version">Express + Socket.io</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useWorkspaceStore } from '../stores/workspace.js';

const workspace = useWorkspaceStore();
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
.settings-section { max-width: 560px; margin-bottom: 20px; }
.section-title { font-size: 13px; font-weight: 600; color: #f4f4f5; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.05em; }
.input-row { display: flex; gap: 8px; }
.input-row input { flex: 1; }
.hint { font-size: 12px; color: #4b5563; margin-top: 6px; }
.ok-text { color: #10b981; font-size: 12px; margin-top: 4px; }
.about-row { display: flex; justify-content: space-between; font-size: 13px; color: #6b7280; margin-bottom: 8px; }
.about-version { color: #4b5563; }
</style>
