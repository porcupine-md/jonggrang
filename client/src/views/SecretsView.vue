<template>
  <div class="secrets-root">

    <!-- LEFT: secret list -->
    <div class="secrets-list">
      <div class="secrets-list-header">
        <span class="secrets-list-title">Secrets</span>
        <button class="btn-new-secret" @click="openNew">+ New</button>
      </div>
      <div class="secrets-list-items">
        <div
          v-for="s in store.list"
          :key="s.id"
          class="secret-item"
          :class="{ 'secret-item--active': selected?.id === s.id && !isNew }"
          @click="openSecret(s.id)"
        >
          <div class="secret-item-name">{{ s.name }}</div>
          <div class="secret-item-meta">{{ s.var_count }} var{{ s.var_count !== 1 ? 's' : '' }}</div>
        </div>
        <div v-if="!store.loading && store.list.length === 0" class="secrets-empty-list">
          No secrets yet
        </div>
      </div>
    </div>

    <!-- RIGHT: editor -->
    <div class="secrets-content">

      <!-- Import preview overlay -->
      <div v-if="showImportPreview" class="import-overlay">
        <div class="import-preview">
          <div class="import-preview-header">
            <span class="import-preview-title">Preview import</span>
            <span class="import-preview-count">{{ previewVars.length }} variable{{ previewVars.length !== 1 ? 's' : '' }} found</span>
          </div>
          <div class="import-preview-list">
            <div v-for="(row, i) in previewVars" :key="i" class="import-preview-row">
              <span class="preview-key">{{ row.key }}</span>
              <span class="preview-val">{{ row.value }}</span>
              <button class="preview-remove" @click="previewVars.splice(i, 1)" title="Remove">×</button>
            </div>
            <div v-if="previewVars.length === 0" class="preview-empty">Nothing to import</div>
          </div>
          <div class="import-preview-footer">
            <Button severity="secondary" size="small" @click="showImportPreview = false">Cancel</Button>
            <Button size="small" :disabled="previewVars.length === 0" @click="confirmImport">
              <i class="pi pi-check" /> Confirm & Import
            </Button>
          </div>
        </div>
      </div>

      <!-- Import input modal -->
      <div v-else-if="showImportInput" class="import-overlay">
        <div class="import-input-panel">
          <div class="import-input-header">Import .env</div>
          <div class="import-tabs">
            <button :class="['import-tab', importTab === 'file' ? 'import-tab--active' : '']" @click="importTab = 'file'">Upload file</button>
            <button :class="['import-tab', importTab === 'paste' ? 'import-tab--active' : '']" @click="importTab = 'paste'">Paste text</button>
          </div>
          <div v-if="importTab === 'file'" class="import-file-zone">
            <input ref="fileInputEl" type="file" accept=".env,.txt,text/plain" style="display:none" @change="onFileChange" />
            <button class="btn-upload" @click="fileInputEl.click()">
              <i class="pi pi-upload" /> Choose .env file
            </button>
            <span v-if="uploadedFileName" class="upload-filename">{{ uploadedFileName }}</span>
          </div>
          <div v-else class="import-paste-zone">
            <textarea
              v-model="pasteText"
              class="paste-textarea"
              placeholder="DATABASE_URL=postgres://...&#10;API_KEY=secret123&#10;# comments are skipped"
              rows="8"
            />
          </div>
          <div class="import-input-footer">
            <Button severity="secondary" size="small" @click="cancelImport">Cancel</Button>
            <Button size="small" @click="parseImport">
              <i class="pi pi-eye" /> Preview
            </Button>
          </div>
        </div>
      </div>

      <!-- New secret form -->
      <div v-else-if="isNew" class="editor-wrap">
        <div class="editor-header">
          <span class="editor-title">New Secret</span>
        </div>
        <div class="editor-body">
          <div class="field-group">
            <label>Name</label>
            <input v-model="editName" class="field-input" placeholder="e.g. prod-db" />
          </div>
          <div class="field-group">
            <label>Description</label>
            <input v-model="editDesc" class="field-input" placeholder="Optional description" />
          </div>
          <div class="vars-section">
            <div class="vars-header">
              <span class="vars-title">Variables</span>
              <button class="btn-import-env" @click="openImport">Import .env</button>
              <button class="btn-add-var" @click="addVar">+ Add</button>
            </div>
            <div class="vars-table">
              <div v-for="(row, i) in editVars" :key="i" class="var-row">
                <input v-model="row.key" class="var-key" placeholder="KEY" />
                <div class="var-val-wrap">
                  <input
                    v-model="row.value"
                    :type="row.revealed ? 'text' : 'password'"
                    class="var-val"
                    placeholder="value"
                  />
                  <button class="var-eye" @click="row.revealed = !row.revealed" :title="row.revealed ? 'Hide' : 'Reveal'">
                    <i :class="row.revealed ? 'pi pi-eye-slash' : 'pi pi-eye'" />
                  </button>
                </div>
                <button class="var-remove" @click="editVars.splice(i, 1)">×</button>
              </div>
              <div v-if="editVars.length === 0" class="vars-empty">No variables yet</div>
            </div>
          </div>
          <div v-if="saveError" class="error-text">{{ saveError }}</div>
        </div>
        <div class="editor-footer">
          <Button severity="secondary" size="small" @click="cancelNew">Cancel</Button>
          <Button size="small" :disabled="!editName.trim() || saving" @click="saveNew">
            <i class="pi pi-save" /> {{ saving ? 'Saving...' : 'Save' }}
          </Button>
        </div>
      </div>

      <!-- Edit existing secret -->
      <div v-else-if="selected" class="editor-wrap">
        <div class="editor-header">
          <span class="editor-title">{{ selected.name }}</span>
          <Button severity="danger" size="small" :disabled="saving" @click="deleteSecret">
            <i class="pi pi-trash" /> Delete
          </Button>
        </div>
        <div class="editor-body">
          <div class="field-group">
            <label>Name</label>
            <input v-model="editName" class="field-input" />
          </div>
          <div class="field-group">
            <label>Description</label>
            <input v-model="editDesc" class="field-input" placeholder="Optional description" />
          </div>
          <div class="vars-section">
            <div class="vars-header">
              <span class="vars-title">Variables</span>
              <button class="btn-import-env" @click="openImport">Import .env</button>
              <button class="btn-add-var" @click="addVar">+ Add</button>
            </div>
            <div class="vars-table">
              <div v-for="(row, i) in editVars" :key="i" class="var-row">
                <input v-model="row.key" class="var-key" placeholder="KEY" />
                <div class="var-val-wrap">
                  <input
                    v-model="row.value"
                    :type="row.revealed ? 'text' : 'password'"
                    class="var-val"
                    placeholder="value"
                  />
                  <button class="var-eye" @click="row.revealed = !row.revealed" :title="row.revealed ? 'Hide' : 'Reveal'">
                    <i :class="row.revealed ? 'pi pi-eye-slash' : 'pi pi-eye'" />
                  </button>
                </div>
                <button class="var-remove" @click="editVars.splice(i, 1)">×</button>
              </div>
              <div v-if="editVars.length === 0" class="vars-empty">No variables yet</div>
            </div>
          </div>
          <div v-if="saveError" class="error-text">{{ saveError }}</div>
        </div>
        <div class="editor-footer">
          <Button size="small" :disabled="saving" @click="saveEdits">
            <i class="pi pi-save" /> {{ saving ? 'Saving...' : 'Save changes' }}
          </Button>
        </div>
      </div>

      <!-- Empty state -->
      <div v-else class="secrets-empty-state">
        <i class="pi pi-lock secrets-empty-icon" />
        <div class="secrets-empty-title">Secret Management</div>
        <div class="secrets-empty-desc">Create secrets to inject env vars into agent & terminal sessions</div>
        <Button size="small" @click="openNew"><i class="pi pi-plus" /> New Secret</Button>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import Button from 'primevue/button';
import { useSecretsStore } from '../stores/secrets.js';

const store = useSecretsStore();

const selected = ref(null);
const isNew = ref(false);

const editName = ref('');
const editDesc = ref('');
const editVars = ref([]);
const saving = ref(false);
const saveError = ref('');

const showImportInput = ref(false);
const showImportPreview = ref(false);
const importTab = ref('file');
const pasteText = ref('');
const uploadedFileName = ref('');
const uploadedText = ref('');
const previewVars = ref([]);

const fileInputEl = ref(null);

onMounted(() => store.fetchAll());

function openNew() {
  isNew.value = true;
  selected.value = null;
  editName.value = '';
  editDesc.value = '';
  editVars.value = [];
  saveError.value = '';
}

function cancelNew() {
  isNew.value = false;
  selected.value = null;
}

async function openSecret(id) {
  isNew.value = false;
  saveError.value = '';
  try {
    const full = await store.fetchOne(id);
    selected.value = full;
    editName.value = full.name;
    editDesc.value = full.description || '';
    editVars.value = Object.entries(full.vars || {}).map(([key, value]) => ({ key, value, revealed: false }));
  } catch {}
}

function addVar() {
  editVars.value.push({ key: '', value: '', revealed: false });
}

function varsToObject() {
  const obj = {};
  for (const { key, value } of editVars.value) {
    if (key.trim()) obj[key.trim()] = value;
  }
  return obj;
}

async function saveNew() {
  if (!editName.value.trim() || saving.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await store.create({ name: editName.value.trim(), description: editDesc.value, vars: varsToObject() });
    isNew.value = false;
  } catch (e) {
    saveError.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function saveEdits() {
  if (!selected.value || saving.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await store.update(selected.value.id, { name: editName.value.trim(), description: editDesc.value, vars: varsToObject() });
    selected.value = { ...selected.value, name: editName.value.trim(), description: editDesc.value };
  } catch (e) {
    saveError.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function deleteSecret() {
  if (!selected.value || !confirm(`Delete secret "${selected.value.name}"?`)) return;
  try {
    await store.remove(selected.value.id);
    selected.value = null;
  } catch {}
}

// ── Import .env ──────────────────────────────────────────────────────────────

function openImport() {
  importTab.value = 'file';
  pasteText.value = '';
  uploadedFileName.value = '';
  uploadedText.value = '';
  showImportInput.value = true;
  showImportPreview.value = false;
}

function cancelImport() {
  showImportInput.value = false;
  showImportPreview.value = false;
}

function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  uploadedFileName.value = file.name;
  const reader = new FileReader();
  reader.onload = (ev) => { uploadedText.value = ev.target.result; };
  reader.readAsText(file);
}

function parseEnvText(text) {
  const vars = [];
  for (const line of (text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.replace(/^export\s+/, '');
    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx < 1) continue;
    const key = withoutExport.slice(0, eqIdx).trim();
    let value = withoutExport.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) vars.push({ key, value });
  }
  return vars;
}

function parseImport() {
  const text = importTab.value === 'file' ? uploadedText.value : pasteText.value;
  previewVars.value = parseEnvText(text);
  showImportInput.value = false;
  showImportPreview.value = true;
}

function confirmImport() {
  const existing = new Map(editVars.value.map(r => [r.key, r]));
  for (const { key, value } of previewVars.value) {
    if (existing.has(key)) {
      existing.get(key).value = value;
    } else {
      editVars.value.push({ key, value, revealed: false });
    }
  }
  showImportPreview.value = false;
  previewVars.value = [];
}
</script>

<style scoped>
.secrets-root {
  display: flex; height: 100%; overflow: hidden;
}

/* LEFT list */
.secrets-list {
  width: 220px; flex-shrink: 0;
  border-right: 1px solid var(--jg-border);
  display: flex; flex-direction: column; overflow: hidden;
}
.secrets-list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.secrets-list-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--jg-text-faint); }
.btn-new-secret {
  font-family: var(--font-mono); font-size: 11px; font-weight: 500;
  color: var(--jg-green); background: transparent; border: 1px solid var(--jg-green);
  padding: 2px 8px; cursor: pointer; transition: background 0.12s;
}
.btn-new-secret:hover { background: color-mix(in oklch, var(--jg-green) 12%, transparent); }

.secrets-list-items { flex: 1; overflow-y: auto; padding: 4px; }
.secret-item {
  padding: 8px 10px; cursor: pointer; border: 1px solid transparent;
  transition: background 0.12s; margin-bottom: 2px;
}
.secret-item:hover { background: var(--jg-hover); }
.secret-item--active {
  background: color-mix(in oklch, var(--jg-green) 10%, transparent);
  border-color: color-mix(in oklch, var(--jg-green) 30%, transparent);
}
.secret-item-name { font-size: 12px; color: var(--jg-text); margin-bottom: 2px; }
.secret-item-meta { font-size: 10px; color: var(--jg-text-faint); }
.secrets-empty-list { padding: 12px; font-size: 11px; color: var(--jg-text-faint); text-align: center; }

/* RIGHT content */
.secrets-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; position: relative; }

/* Empty state */
.secrets-empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 8px; text-align: center; padding: 24px;
}
.secrets-empty-icon { font-size: 36px; color: var(--jg-green); }
.secrets-empty-title { font-size: 14px; font-weight: 600; color: var(--jg-text); }
.secrets-empty-desc { font-size: 12px; color: var(--jg-text-muted); max-width: 320px; }

/* Editor */
.editor-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.editor-header {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.editor-title { font-size: 13px; font-weight: 600; color: var(--jg-text); }
.editor-body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.editor-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--jg-border); flex-shrink: 0;
}

/* Fields */
.field-group { display: flex; flex-direction: column; gap: 4px; }
.field-group label { font-size: 11px; color: var(--jg-text-faint); }
.field-input {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); padding: 6px 10px; outline: none; width: 100%; max-width: 480px;
}
.field-input:focus { border-color: var(--jg-green); }

/* Variables table */
.vars-section { display: flex; flex-direction: column; gap: 8px; }
.vars-header { display: flex; align-items: center; gap: 8px; }
.vars-title { font-size: 11px; color: var(--jg-text-faint); }
.btn-import-env, .btn-add-var {
  font-family: var(--font-mono); font-size: 11px; cursor: pointer;
  background: transparent; border: 1px solid var(--jg-border); color: var(--jg-text-muted);
  padding: 2px 8px; transition: border-color 0.12s, color 0.12s;
}
.btn-import-env:hover, .btn-add-var:hover { border-color: var(--jg-green); color: var(--jg-green); }

.vars-table { display: flex; flex-direction: column; gap: 4px; max-width: 680px; }
.var-row { display: flex; gap: 6px; align-items: center; }
.var-key {
  flex: 0 0 200px; font-family: var(--font-mono); font-size: 11px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); padding: 5px 8px; outline: none;
}
.var-key:focus { border-color: var(--jg-green); }
.var-val-wrap { flex: 1; display: flex; position: relative; }
.var-val {
  flex: 1; font-family: var(--font-mono); font-size: 11px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); padding: 5px 30px 5px 8px; outline: none; min-width: 0;
}
.var-val:focus { border-color: var(--jg-green); }
.var-eye {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer; color: var(--jg-text-faint);
  font-size: 11px; padding: 0;
}
.var-eye:hover { color: var(--jg-text); }
.var-remove {
  background: none; border: none; cursor: pointer; color: var(--jg-text-faint);
  font-size: 14px; padding: 0 4px; line-height: 1;
}
.var-remove:hover { color: var(--jg-red); }
.vars-empty { font-size: 11px; color: var(--jg-text-faint); padding: 8px 0; }

/* Import overlay */
.import-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center; z-index: 10;
}
.import-input-panel, .import-preview {
  background: var(--jg-card); border: 1px solid var(--jg-border);
  width: 520px; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden;
}
.import-input-header, .import-preview-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
  font-size: 12px; font-weight: 600; color: var(--jg-text);
}
.import-preview-count { font-size: 11px; font-weight: 400; color: var(--jg-text-faint); }

.import-tabs { display: flex; border-bottom: 1px solid var(--jg-border); flex-shrink: 0; }
.import-tab {
  flex: 1; padding: 8px 12px; background: none; border: none;
  font-family: var(--font-mono); font-size: 11px; color: var(--jg-text-faint);
  cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.import-tab--active { color: var(--jg-green); border-bottom-color: var(--jg-green); }

.import-file-zone {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 24px; flex: 1;
}
.btn-upload {
  font-family: var(--font-mono); font-size: 12px; cursor: pointer;
  background: transparent; border: 1px solid var(--jg-border); color: var(--jg-text-muted);
  padding: 8px 16px; display: flex; align-items: center; gap: 6px;
  transition: border-color 0.12s, color 0.12s;
}
.btn-upload:hover { border-color: var(--jg-green); color: var(--jg-green); }
.upload-filename { font-size: 11px; color: var(--jg-green); }

.import-paste-zone { padding: 12px 16px; flex: 1; display: flex; flex-direction: column; }
.paste-textarea {
  flex: 1; font-family: var(--font-mono); font-size: 11px; resize: none;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); padding: 8px; outline: none; min-height: 140px;
}
.paste-textarea:focus { border-color: var(--jg-green); }

.import-input-footer, .import-preview-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--jg-border); flex-shrink: 0;
}

.import-preview-list { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.import-preview-row {
  display: flex; align-items: center; gap: 8px;
  background: var(--jg-bg); border: 1px solid var(--jg-border); padding: 5px 8px;
}
.preview-key { font-size: 11px; font-weight: 600; color: var(--jg-cyan); flex: 0 0 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-val { font-size: 11px; color: var(--jg-text-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-remove {
  background: none; border: none; cursor: pointer; color: var(--jg-text-faint);
  font-size: 14px; padding: 0 4px; line-height: 1; flex-shrink: 0;
}
.preview-remove:hover { color: var(--jg-red); }
.preview-empty { font-size: 11px; color: var(--jg-text-faint); text-align: center; padding: 12px; }
</style>
