<template>
  <div class="settings-view">
    <div class="settings-body">

      <!-- Jonggrang Config -->
      <section class="settings-section">
        <div class="section-title">Jonggrang Config</div>
        <div class="section-content">
          <div class="field-row">
            <div class="field-group">
              <label>AI Tool</label>
              <Select v-model="cfg.tool" :options="toolOptions" optionLabel="label" optionValue="value" class="field-select" />
            </div>
            <div class="field-group">
              <label>Autonomy</label>
              <Select v-model="cfg.autonomy" :options="autonomyOptions" optionLabel="label" optionValue="value" class="field-select" />
            </div>
          </div>
          <div v-if="cfgError" class="error-text">{{ cfgError }}</div>
          <div v-if="cfgSaved" class="saved-text"><i class="pi pi-check" /> Saved</div>
          <div class="section-footer">
            <Button size="small" :disabled="cfgSaving" @click="saveConfig">
              <i class="pi pi-save" /> {{ cfgSaving ? 'Saving...' : 'Save Config' }}
            </Button>
          </div>
        </div>
      </section>

      <!-- Sandbox -->
      <section class="settings-section">
        <div class="section-title">Docker Sandbox</div>
        <div class="section-desc">Run Agent and Terminal inside an isolated Docker container.</div>
        <div class="section-content">
          <label class="sandbox-toggle-row">
            <input type="checkbox" v-model="sbx.enabled" />
            <span>Enable Docker sandbox</span>
          </label>
          <div class="field-group" :class="{ 'field-disabled': !sbx.enabled }">
            <label>Image <span class="override-hint">(leave blank to use global)</span></label>
            <input v-model="sbx.image" :disabled="!sbx.enabled" :placeholder="globalSbx.image || 'orcinus/jonggrang-agent'" class="sandbox-image-input" />
          </div>
          <div class="field-group" :class="{ 'field-disabled': !sbx.enabled }">
            <label>Shell <span class="override-hint">(leave blank to use global)</span></label>
            <input v-model="sbx.shell" :disabled="!sbx.enabled" :placeholder="globalSbx.shell || '/bin/bash'" class="sandbox-image-input" />
          </div>
          <div v-if="sbxError" class="error-text">{{ sbxError }}</div>
          <div v-if="sbxSaved" class="saved-text"><i class="pi pi-check" /> Saved</div>
          <div class="section-footer">
            <Button size="small" :disabled="sbxSaving" @click="saveSandbox">
              <i class="pi pi-save" /> {{ sbxSaving ? 'Saving...' : 'Save Sandbox' }}
            </Button>
          </div>
        </div>
      </section>

      <!-- Secrets -->
      <section class="settings-section">
        <div class="section-title">Secrets</div>
        <div class="section-desc">Select which secrets are injected as env vars when Agent or Terminal starts.</div>
        <div class="section-content">
          <div v-if="secretsLoading" class="loading-text">Loading secrets...</div>
          <div v-else-if="allSecrets.length === 0" class="empty-secrets">
            No secrets defined yet.
            <RouterLink to="/secrets" class="link">Manage secrets →</RouterLink>
          </div>
          <div v-else class="secrets-list">
            <label v-for="s in allSecrets" :key="s.id" class="secret-checkbox-row">
              <input type="checkbox" :checked="attachedSecrets.includes(s.id)" @change="toggleSecret(s.id)" />
              <div class="secret-info">
                <span class="secret-name">{{ s.name }}</span>
                <span class="secret-vars">{{ s.var_count }} var{{ s.var_count !== 1 ? 's' : '' }}</span>
                <span v-if="s.description" class="secret-desc">{{ s.description }}</span>
              </div>
            </label>
          </div>
          <div v-if="secretsError" class="error-text">{{ secretsError }}</div>
          <div v-if="secretsSaved" class="saved-text"><i class="pi pi-check" /> Saved</div>
          <div class="section-footer" v-if="allSecrets.length > 0">
            <Button size="small" :disabled="secretsSaving" @click="saveSecrets">
              <i class="pi pi-save" /> {{ secretsSaving ? 'Saving...' : 'Save Secrets' }}
            </Button>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useSecretsStore } from '../stores/secrets.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const secretsStore = useSecretsStore();

const toolOptions = [
  { label: 'Jonggrang (Pi)', value: 'jonggrang' },
  { label: 'Claude Code', value: 'claude' },
  { label: 'OpenCode', value: 'opencode' },
];
const autonomyOptions = [
  { label: 'Full (auto-approve)', value: 'autonomous' },
  { label: 'Supervised', value: 'supervised' },
];

const cfg = reactive({ tool: 'jonggrang', autonomy: 'autonomous' });
const cfgSaving = ref(false);
const cfgError = ref('');
const cfgSaved = ref(false);

const sbx = reactive({ enabled: false, image: '', shell: '' });
const globalSbx = reactive({ image: '', shell: '' });
const sbxSaving = ref(false);
const sbxError = ref('');
const sbxSaved = ref(false);

const attachedSecrets = ref([]);
const secretsSaving = ref(false);
const secretsError = ref('');
const secretsSaved = ref(false);
const secretsLoading = ref(false);

const allSecrets = computed(() => secretsStore.list);

onMounted(async () => {
  secretsLoading.value = true;
  try {
    const [settingsRes] = await Promise.all([
      fetch(`/api/projects/${projectId.value}/settings`),
      secretsStore.fetchAll(),
    ]);
    if (settingsRes.ok) {
      const data = await settingsRes.json();
      if (data.jonggrang_config?.tool) cfg.tool = data.jonggrang_config.tool;
      if (data.jonggrang_config?.autonomy) cfg.autonomy = data.jonggrang_config.autonomy;
      attachedSecrets.value = Array.isArray(data.secrets) ? [...data.secrets] : [];
      if (data.sandbox) { sbx.enabled = !!data.sandbox.enabled; sbx.image = data.sandbox.image || ''; sbx.shell = data.sandbox.shell || ''; }
      fetch('/api/settings/sandbox').then(r => r.json()).then(d => { globalSbx.image = d.image || ''; globalSbx.shell = d.shell || ''; }).catch(() => {});
    }
  } catch {}
  secretsLoading.value = false;
});

async function saveConfig() {
  cfgSaving.value = true;
  cfgError.value = '';
  cfgSaved.value = false;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jonggrang_config: { tool: cfg.tool, autonomy: cfg.autonomy } }),
    });
    if (!res.ok) throw new Error('Save failed');
    cfgSaved.value = true;
    setTimeout(() => { cfgSaved.value = false; }, 2000);
  } catch (e) {
    cfgError.value = e.message;
  } finally {
    cfgSaving.value = false;
  }
}

function toggleSecret(id) {
  const idx = attachedSecrets.value.indexOf(id);
  if (idx >= 0) attachedSecrets.value.splice(idx, 1);
  else attachedSecrets.value.push(id);
}

async function saveSandbox() {
  sbxSaving.value = true;
  sbxError.value = '';
  sbxSaved.value = false;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandbox: { enabled: sbx.enabled, image: sbx.image || null, shell: sbx.shell || null } }),
    });
    if (!res.ok) throw new Error('Save failed');
    sbxSaved.value = true;
    setTimeout(() => { sbxSaved.value = false; }, 2000);
  } catch (e) {
    sbxError.value = e.message;
  } finally {
    sbxSaving.value = false;
  }
}

async function saveSecrets() {
  secretsSaving.value = true;
  secretsError.value = '';
  secretsSaved.value = false;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secrets: attachedSecrets.value }),
    });
    if (!res.ok) throw new Error('Save failed');
    secretsSaved.value = true;
    setTimeout(() => { secretsSaved.value = false; }, 2000);
  } catch (e) {
    secretsError.value = e.message;
  } finally {
    secretsSaving.value = false;
  }
}
</script>

<style scoped>
.settings-view { height: 100%; overflow-y: auto; }
.settings-body { max-width: 640px; padding: 24px; display: flex; flex-direction: column; gap: 24px; }

.settings-section {
  border: 1px solid var(--jg-border); background: var(--jg-card);
}
.section-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--jg-text-faint); padding: 10px 16px; border-bottom: 1px solid var(--jg-border);
}
.section-desc { font-size: 11px; color: var(--jg-text-faint); padding: 8px 16px 0; }
.section-content { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.section-footer { display: flex; justify-content: flex-end; padding-top: 4px; }

.field-row { display: flex; gap: 16px; }
.field-group { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.field-group label { font-size: 11px; color: var(--jg-text-faint); }
.field-select { width: 100%; }
.field-select :deep(.p-select) { font-size: 12px; }

.secrets-list { display: flex; flex-direction: column; gap: 6px; }
.secret-checkbox-row {
  display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
  padding: 8px 10px; border: 1px solid var(--jg-border);
  transition: background 0.12s;
}
.secret-checkbox-row:hover { background: var(--jg-hover); }
.secret-checkbox-row input[type="checkbox"] { margin-top: 1px; accent-color: var(--jg-green); }
.secret-info { display: flex; flex-direction: column; gap: 2px; }
.secret-name { font-size: 12px; color: var(--jg-text); font-weight: 500; }
.secret-vars { font-size: 10px; color: var(--jg-text-faint); }
.secret-desc { font-size: 11px; color: var(--jg-text-muted); }

.loading-text { font-size: 12px; color: var(--jg-text-faint); }
.sandbox-toggle-row {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: 12px; color: var(--jg-text-muted); margin-bottom: 0;
}
.sandbox-toggle-row input[type="checkbox"] { accent-color: var(--jg-green); }
.sandbox-image-input {
  width: 100%; padding: 6px 10px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: inherit; font-size: 12px;
  outline: none; margin-top: 4px;
}
.sandbox-image-input:focus { border-color: var(--jg-green); }
.sandbox-hint { font-size: 11px; color: var(--jg-text-faint); margin-top: 4px; }
.override-hint { font-size: 10px; color: var(--jg-text-faint); font-weight: 400; }
.field-disabled { opacity: 0.45; }
.sandbox-image-input:disabled { cursor: not-allowed; }
.empty-secrets { font-size: 12px; color: var(--jg-text-faint); display: flex; align-items: center; gap: 8px; }
.link { color: var(--jg-cyan); text-decoration: none; font-size: 12px; }
.link:hover { text-decoration: underline; }
.saved-text { font-size: 11px; color: var(--jg-green); display: flex; align-items: center; gap: 4px; }
</style>
