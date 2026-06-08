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

    <!-- Sandbox -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-box" /> Docker Sandbox</div>
      <div class="form-group">
        <label>Default Image</label>
        <InputText v-model="sbx.image" placeholder="orcinus/jonggrang-agent" style="width:100%" />
        <p class="hint">Docker image used for all sandbox projects.</p>
      </div>
      <div class="form-group">
        <label>Shell</label>
        <InputText v-model="sbx.shell" placeholder="/bin/bash" style="width:100%" />
        <p class="hint">Shell binary inside the container (e.g. /bin/bash, /bin/sh).</p>
      </div>
      <div class="form-group">
        <label>Docker Network</label>
        <InputText v-model="sbx.network" placeholder="jonggrang" style="width:100%" />
        <p class="hint">Docker network semua sandbox container akan dikoneksikan. Default: jonggrang.</p>
      </div>

      <!-- Volume Mounts -->
      <div class="form-group">
        <div class="vol-header">
          <label>Volume Mounts</label>
          <button class="vol-add-btn" @click="startAddVolume"><i class="pi pi-plus" /> Add</button>
        </div>
        <div class="vol-list" v-if="sbx.volumes.length > 0 || addingVolume">
          <div v-for="vol in sbx.volumes" :key="vol.id" class="vol-row">
            <label class="vol-toggle" :title="vol.enabled ? 'Disable' : 'Enable'">
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
            <button class="vol-del-btn" @click="removeVolume(vol.id)" title="Remove"><i class="pi pi-times" /></button>
          </div>

          <!-- Add form row -->
          <div v-if="addingVolume" class="vol-add-row">
            <input v-model="newVol.source" placeholder="Source path (host)" class="vol-input" />
            <i class="pi pi-arrow-right vol-arrow" />
            <input v-model="newVol.destination" placeholder="Destination (container)" class="vol-input" />
            <select v-model="newVol.type" class="vol-select">
              <option value="bind">bind</option>
              <option value="nfs">nfs</option>
              <option value="tmpfs">tmpfs</option>
            </select>
            <label class="vol-ro-check" title="Read-only">
              <input type="checkbox" v-model="newVol.readonly" /> ro
            </label>
            <button class="vol-confirm-btn" @click="confirmAddVolume"><i class="pi pi-check" /></button>
            <button class="vol-del-btn" @click="cancelAddVolume"><i class="pi pi-times" /></button>
          </div>
        </div>
        <div v-else class="vol-empty">No extra volumes configured.</div>
        <div v-if="volCheckError" class="error-text" style="margin-top:4px"><i class="pi pi-exclamation-triangle" /> {{ volCheckError }}</div>
        <p class="hint">Applied to all sandbox containers. Project-level volumes are added on top.</p>
      </div>

      <div v-if="sbxError" class="error-text"><i class="pi pi-times-circle" /> {{ sbxError }}</div>
      <div v-if="sbxOk" class="ok-text"><i class="pi pi-check-circle" /> Saved!</div>
      <Button :disabled="sbxSaving" @click="saveSandbox" :icon="sbxSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="sbxSaving ? 'Saving…' : 'Save'" />
    </div>

    <!-- Git SSH Key (global) -->
    <div class="settings-card">
      <div class="card-title"><i class="pi pi-key" /> Git SSH Key (global)</div>
      <p class="hint">Default private key mounted into every sandbox for in-container <code>git push</code>. A per-project key (set in a project's Settings) overrides this; if neither is set, <code>~/.ssh/id_rsa</code> is used. Restart sandboxes after changing.</p>
      <div class="ssh-status">Active: <strong>{{ gssh.source }}</strong> <span v-if="gssh.path" class="ssh-path">{{ gssh.path }}</span></div>
      <div v-if="gssh.fingerprint" class="ssh-fp">{{ gssh.fingerprint }}</div>
      <label class="ssh-label">Paste the global private key</label>
      <textarea
        v-model="gsshInput"
        class="ssh-input"
        rows="4"
        spellcheck="false"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
      ></textarea>
      <div v-if="gsshError" class="error-text"><i class="pi pi-times-circle" /> {{ gsshError }}</div>
      <div v-if="gsshOk" class="ok-text"><i class="pi pi-check-circle" /> Saved — restart sandboxes to apply</div>
      <div class="ssh-actions">
        <Button :disabled="gsshSaving || !gsshInput.trim()" @click="saveGlobalSshKey" :icon="gsshSaving ? 'pi pi-spin pi-spinner' : 'pi pi-check'" :label="gsshSaving ? 'Saving…' : 'Save key'" />
        <Button severity="secondary" :disabled="gsshSaving || !gssh.has_global_key" @click="clearGlobalSshKey" icon="pi pi-times" label="Remove global key" />
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
import { ref, reactive, onMounted } from 'vue';
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

const sbx = reactive({ image: '', shell: '', network: '', volumes: [] });
const sbxSaving = ref(false);
const sbxError = ref('');
const sbxOk = ref(false);

const addingVolume = ref(false);
const newVol = reactive({ source: '', destination: '', type: 'bind', readonly: false });
const volCheckError = ref('');

const gssh = reactive({ source: 'none', path: null, has_global_key: false, fingerprint: '' });
const gsshInput = ref('');
const gsshSaving = ref(false);
const gsshError = ref('');
const gsshOk = ref(false);

onMounted(async () => {
  await workspace.fetch();
  workspacePath.value = workspace.path;
  try {
    const res = await fetch('/api/settings/sandbox');
    if (res.ok) {
      const d = await res.json();
      sbx.image = d.image || '';
      sbx.shell = d.shell || '';
      sbx.network = d.network || '';
      sbx.volumes = Array.isArray(d.volumes) ? d.volumes : [];
    }
  } catch {}
  await loadGlobalSshKey();
});

async function loadGlobalSshKey() {
  try {
    const r = await fetch('/api/settings/ssh-key');
    if (r.ok) Object.assign(gssh, await r.json());
  } catch {}
}

async function saveGlobalSshKey() {
  gsshSaving.value = true; gsshError.value = ''; gsshOk.value = false;
  try {
    const r = await fetch('/api/settings/ssh-key', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: gsshInput.value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed to save key');
    Object.assign(gssh, d); gsshInput.value = ''; gsshOk.value = true;
  } catch (e) { gsshError.value = e.message; } finally { gsshSaving.value = false; }
}

async function clearGlobalSshKey() {
  gsshSaving.value = true; gsshError.value = ''; gsshOk.value = false;
  try {
    const r = await fetch('/api/settings/ssh-key', { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed');
    Object.assign(gssh, d);
  } catch (e) { gsshError.value = e.message; } finally { gsshSaving.value = false; }
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
  if (!newVol.destination) {
    volCheckError.value = 'Destination is required.';
    return;
  }
  if (newVol.type !== 'tmpfs' && !newVol.source) {
    volCheckError.value = 'Source path is required.';
    return;
  }
  // Check source existence (skip for tmpfs)
  if (newVol.type !== 'tmpfs') {
    try {
      const r = await fetch('/api/settings/sandbox/volumes/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: newVol.source }),
      });
      const d = await r.json();
      if (!d.exists) {
        volCheckError.value = `Path not found on host: ${newVol.source}`;
        return;
      }
    } catch {
      volCheckError.value = 'Could not verify path.';
      return;
    }
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
      if (!d.exists) {
        vol.error = `Path not found: ${vol.source}`;
        return;
      }
    } catch {
      vol.error = 'Could not verify path.';
      return;
    }
  }
  vol.error = null;
  vol.enabled = enabling;
}

async function saveSandbox() {
  sbxSaving.value = true;
  sbxError.value = '';
  sbxOk.value = false;
  try {
    const res = await fetch('/api/settings/sandbox', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: sbx.image || 'orcinus/jonggrang-agent',
        shell: sbx.shell || '/bin/bash',
        network: sbx.network || 'jonggrang',
        volumes: sbx.volumes,
      }),
    });
    if (!res.ok) throw new Error('Save failed');
    sbxOk.value = true;
    setTimeout(() => { sbxOk.value = false; }, 2000);
  } catch (e) {
    sbxError.value = e.message;
  } finally {
    sbxSaving.value = false;
  }
}

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
.ssh-status { font-size: 12px; color: var(--jg-text-muted); margin: 8px 0 4px; }
.ssh-status strong { color: var(--jg-text); text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
.ssh-path { font-family: monospace; font-size: 11px; color: var(--jg-text-faint); margin-left: 8px; }
.ssh-fp { font-family: monospace; font-size: 10px; color: var(--jg-text-faint); margin-bottom: 8px; word-break: break-all; }
.ssh-label { display: block; font-size: 11px; color: var(--jg-text-faint); margin: 8px 0 4px; }
.ssh-input {
  width: 100%; box-sizing: border-box; resize: vertical;
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  color: var(--jg-text-muted); font-family: monospace; font-size: 11px; padding: 8px;
}
.ssh-input:focus { outline: none; border-color: var(--jg-green); }
.ssh-actions { display: flex; gap: 8px; margin-top: 8px; }
.about-row {
  display: flex; justify-content: space-between;
  font-size: 12px; color: var(--jg-text-muted);
  padding: 6px 0; border-bottom: 1px solid var(--jg-border);
}
.about-row:last-child { border-bottom: none; }
.about-val { color: var(--jg-text); font-size: 12px; }

/* Volume mounts */
.vol-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.vol-header label { font-size: 11px; color: var(--jg-text-faint); }
.vol-add-btn {
  background: none; border: 1px solid var(--jg-border); color: var(--jg-text-muted);
  font-size: 11px; padding: 2px 8px; cursor: pointer; display: flex; align-items: center; gap: 4px;
}
.vol-add-btn:hover { border-color: var(--jg-green); color: var(--jg-green); }
.vol-list { display: flex; flex-direction: column; gap: 2px; }
.vol-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border: 1px solid var(--jg-border);
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
.vol-del-btn {
  background: none; border: none; color: var(--jg-text-faint);
  cursor: pointer; padding: 2px 4px; flex-shrink: 0;
}
.vol-del-btn:hover { color: var(--jg-red, #e06c75); }
.vol-confirm-btn {
  background: none; border: none; color: var(--jg-green);
  cursor: pointer; padding: 2px 4px; flex-shrink: 0;
}
.vol-error-icon { color: var(--jg-yellow, #d4a800); cursor: help; }
.vol-empty { font-size: 11px; color: var(--jg-text-faint); padding: 6px 0; }
.vol-add-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border: 1px dashed var(--jg-green);
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
