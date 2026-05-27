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

          <!-- Volume Mounts (project-level) -->
          <div class="field-group">
            <div class="vol-header">
              <label>
                Additional Volumes
                <span v-if="globalSbx.volumes && globalSbx.volumes.length > 0" class="override-hint">
                  ({{ globalSbx.volumes.length }} global inherited)
                </span>
              </label>
              <button class="vol-add-btn" @click="startAddVolume"><i class="pi pi-plus" /> Add</button>
            </div>
            <div class="vol-list" v-if="sbx.volumes.length > 0 || addingVolume">
              <div v-for="vol in sbx.volumes" :key="vol.id" class="vol-row">
                <label class="vol-toggle">
                  <input type="checkbox" :checked="vol.enabled" @change="toggleVolume(vol)" />
                </label>
                <span class="vol-path">
                  <span v-if="vol.label" class="vol-label">{{ vol.label }}</span>
                  <span class="vol-source">{{ vol.source }}</span>
                  <i class="pi pi-arrow-right vol-arrow" />
                  <span class="vol-dest">{{ vol.destination }}</span>
                </span>
                <span :class="['vol-badge', `vol-badge--${vol.type || 'bind'}`]">{{ vol.type || 'bind' }}</span>
                <span v-if="vol.readonly" class="vol-badge vol-badge--ro">ro</span>
                <span v-if="vol.error" class="vol-error-icon" :title="vol.error"><i class="pi pi-exclamation-triangle" /></span>
                <button class="vol-del-btn" @click="removeVolume(vol.id)"><i class="pi pi-times" /></button>
              </div>

              <div v-if="addingVolume" class="vol-add-row">
                <input v-model="newVol.source" placeholder="Source (host path)" class="vol-input" />
                <i class="pi pi-arrow-right vol-arrow" />
                <input v-model="newVol.destination" placeholder="Destination (container)" class="vol-input" />
                <select v-model="newVol.type" class="vol-select">
                  <option value="bind">bind</option>
                  <option value="nfs">nfs</option>
                  <option value="tmpfs">tmpfs</option>
                </select>
                <label class="vol-ro-check"><input type="checkbox" v-model="newVol.readonly" /> ro</label>
                <button class="vol-confirm-btn" @click="confirmAddVolume"><i class="pi pi-check" /></button>
                <button class="vol-del-btn" @click="cancelAddVolume"><i class="pi pi-times" /></button>
              </div>
            </div>
            <div v-else class="vol-empty">No extra volumes for this project.</div>
            <div v-if="volCheckError" class="error-text" style="margin-top:4px">{{ volCheckError }}</div>
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

const sbx = reactive({ enabled: false, image: '', shell: '', volumes: [] });
const globalSbx = reactive({ image: '', shell: '', volumes: [] });
const sbxSaving = ref(false);
const sbxError = ref('');
const sbxSaved = ref(false);

const addingVolume = ref(false);
const newVol = reactive({ source: '', destination: '', type: 'bind', readonly: false });
const volCheckError = ref('');

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
      if (data.sandbox) {
        sbx.enabled = !!data.sandbox.enabled;
        sbx.image = data.sandbox.image || '';
        sbx.shell = data.sandbox.shell || '';
        sbx.volumes = Array.isArray(data.sandbox.volumes) ? data.sandbox.volumes : [];
      }
      fetch('/api/settings/sandbox').then(r => r.json()).then(d => {
        globalSbx.image = d.image || '';
        globalSbx.shell = d.shell || '';
        globalSbx.volumes = Array.isArray(d.volumes) ? d.volumes : [];
      }).catch(() => {});
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

function startAddVolume() {
  newVol.source = '';
  newVol.destination = '';
  newVol.type = 'bind';
  newVol.readonly = false;
  volCheckError.value = '';
  addingVolume.value = true;
}

function cancelAddVolume() {
  addingVolume.value = false;
  volCheckError.value = '';
}

async function confirmAddVolume() {
  volCheckError.value = '';
  if (!newVol.destination) { volCheckError.value = 'Destination is required.'; return; }
  if (newVol.type !== 'tmpfs' && !newVol.source) { volCheckError.value = 'Source path is required.'; return; }
  if (newVol.type !== 'tmpfs') {
    try {
      const r = await fetch('/api/settings/sandbox/volumes/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: newVol.source }),
      });
      const d = await r.json();
      if (!d.exists) { volCheckError.value = `Path not found on host: ${newVol.source}`; return; }
    } catch { volCheckError.value = 'Could not verify path.'; return; }
  }
  sbx.volumes.push({
    id: Date.now().toString(36),
    source: newVol.source,
    destination: newVol.destination,
    type: newVol.type,
    readonly: newVol.readonly,
    enabled: true,
  });
  addingVolume.value = false;
}

function removeVolume(id) {
  sbx.volumes = sbx.volumes.filter(v => v.id !== id);
}

async function toggleVolume(vol) {
  const enabling = !vol.enabled;
  if (enabling && vol.type !== 'tmpfs' && vol.source) {
    try {
      const r = await fetch('/api/settings/sandbox/volumes/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: vol.source }),
      });
      const d = await r.json();
      if (!d.exists) { vol.error = `Path not found: ${vol.source}`; return; }
    } catch { vol.error = 'Could not verify path.'; return; }
  }
  vol.error = null;
  vol.enabled = enabling;
}

async function saveSandbox() {
  sbxSaving.value = true;
  sbxError.value = '';
  sbxSaved.value = false;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandbox: { enabled: sbx.enabled, image: sbx.image || null, shell: sbx.shell || null, volumes: sbx.volumes } }),
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

/* Volume mounts */
.vol-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.vol-add-btn {
  background: none; border: 1px solid var(--jg-border); color: var(--jg-text-muted);
  font-size: 11px; padding: 2px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px;
}
.vol-add-btn:hover { border-color: var(--jg-green); color: var(--jg-green); }
.vol-list { display: flex; flex-direction: column; gap: 2px; }
.vol-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border: 1px solid var(--jg-border);
  font-size: 11px; color: var(--jg-text-muted);
}
.vol-row:hover { background: var(--jg-hover); }
.vol-toggle input[type="checkbox"] { accent-color: var(--jg-green); cursor: pointer; }
.vol-path { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow: hidden; }
.vol-label { font-size: 11px; color: var(--jg-text-muted); white-space: nowrap; flex-shrink: 0; }
.vol-source, .vol-dest { font-family: monospace; font-size: 11px; color: var(--jg-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vol-arrow { font-size: 10px; color: var(--jg-text-faint); flex-shrink: 0; }
.vol-badge {
  font-size: 9px; padding: 1px 5px; border: 1px solid var(--jg-border);
  color: var(--jg-text-faint); white-space: nowrap; flex-shrink: 0;
}
.vol-badge--nfs { border-color: var(--jg-cyan); color: var(--jg-cyan); }
.vol-badge--tmpfs { border-color: var(--jg-yellow, #d4a800); color: var(--jg-yellow, #d4a800); }
.vol-badge--ro { border-color: var(--jg-text-faint); }
.vol-del-btn { background: none; border: none; color: var(--jg-text-faint); cursor: pointer; padding: 2px 4px; flex-shrink: 0; }
.vol-del-btn:hover { color: var(--jg-red, #e06c75); }
.vol-confirm-btn { background: none; border: none; color: var(--jg-green); cursor: pointer; padding: 2px 4px; flex-shrink: 0; }
.vol-error-icon { color: var(--jg-yellow, #d4a800); cursor: help; }
.vol-empty { font-size: 11px; color: var(--jg-text-faint); padding: 4px 0; }
.vol-add-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; border: 1px dashed var(--jg-green);
}
.vol-input {
  flex: 1; min-width: 0; background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: monospace; font-size: 11px; padding: 3px 6px; outline: none;
}
.vol-input:focus { border-color: var(--jg-green); }
.vol-select {
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-size: 11px; padding: 3px 4px; outline: none;
}
.vol-ro-check { font-size: 11px; color: var(--jg-text-faint); display: flex; align-items: center; gap: 3px; white-space: nowrap; cursor: pointer; }
.vol-ro-check input { accent-color: var(--jg-green); }
</style>
