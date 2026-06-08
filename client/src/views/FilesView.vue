<template>
  <!-- Full mode: embed openvscode-server proxied through the dashboard -->
  <div v-if="mode === 'full'" class="code-full">
    <iframe v-if="codeUrl" :src="codeUrl" class="code-iframe" title="Code editor" />
    <div v-else class="files-placeholder"><i class="pi pi-spin pi-spinner" /><span>Starting editor…</span></div>
  </div>

  <!-- Lite mode: built-in file tree + CodeMirror -->
  <div v-else class="files-root">
    <div class="files-toolbar">
      <div class="files-title">
        <i class="pi pi-folder-open" /> Files
        <span v-if="featureId" class="files-scope">worktree: {{ featureId }}</span>
      </div>
      <div class="files-actions">
        <span v-if="activePath" class="files-path">{{ activePath }}<span v-if="dirty" class="files-dirty"> ●</span></span>
        <button class="f-btn" :disabled="loadingTree" @click="reloadRoot" title="Refresh"><i class="pi pi-refresh" /></button>
        <button class="f-btn f-btn--save" :disabled="!activePath || !dirty || saving" @click="save">
          <i class="pi pi-save" /> {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="files-error">{{ error }}</p>

    <div class="files-body">
      <div class="files-tree">
        <div v-if="loadingTree" class="files-tree-loading">Loading…</div>
        <FileTree v-for="n in roots" :key="n.path" :node="n" :depth="0" />
      </div>
      <div class="files-editor">
        <div v-show="!activePath" class="files-placeholder">
          <i class="pi pi-file" /><span>Select a file to view or edit.</span>
        </div>
        <div v-show="activePath" ref="editorEl" class="cm-host" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, provide, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import FileTree from '../components/files/FileTree.vue';
import { useProjectsStore } from '../stores/projects.js';

const route = useRoute();
const projects = useProjectsStore();
const projectId = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId || null);
const mode = computed(() => projects.byId[projectId.value]?.code_editor || 'lite');
const codeUrl = ref('');

async function initFullEditor() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/code-status`);
    const data = await res.json();
    let folder = data.folder || '';
    if (featureId.value && folder) folder = `${folder}/.jonggrang/.worktree/${featureId.value}`;
    codeUrl.value = `/api/projects/${projectId.value}/code/` + (folder ? `?folder=${encodeURIComponent(folder)}` : '');
  } catch {
    codeUrl.value = `/api/projects/${projectId.value}/code/`;
  }
}

const roots = ref([]);
const loadingTree = ref(false);
const activePath = ref(null);
const dirty = ref(false);
const saving = ref(false);
const error = ref('');
const editorEl = ref(null);
let view = null;

const qs = (extra = {}) => {
  const p = new URLSearchParams(extra);
  if (featureId.value) p.set('feature_id', featureId.value);
  return p.toString();
};

function langForPath(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext)) return [javascript({ jsx: true, typescript: ext.startsWith('ts') })];
  if (ext === 'json') return [json()];
  if (['html', 'htm', 'vue'].includes(ext)) return [html()];
  if (['css', 'scss', 'less'].includes(ext)) return [css()];
  if (['md', 'markdown'].includes(ext)) return [markdown()];
  if (ext === 'py') return [python()];
  return [];
}

async function listDir(relPath) {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/files?${qs({ path: relPath || '' })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'List failed');
    // attach full relative path to each entry
    return (data.entries || []).map(e => ({ ...e, path: relPath ? `${relPath}/${e.name}` : e.name }));
  } catch (e) {
    error.value = e.message;
    return [];
  }
}

async function openFile(relPath) {
  error.value = '';
  try {
    const res = await fetch(`/api/projects/${projectId.value}/files/content?${qs({ path: relPath })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Open failed');
    activePath.value = relPath;
    dirty.value = false;
    await nextTick();
    setEditorContent(data.content, relPath);
  } catch (e) {
    error.value = e.message;
  }
}

// shared API for the recursive tree — plain object so the `activePath` ref is
// passed through intact (reactive() would unwrap it and break `.value`).
provide('filesApi', { activePath, list: listDir, open: openFile });

function setEditorContent(content, relPath) {
  const state = EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      oneDark,
      ...langForPath(relPath),
      EditorView.updateListener.of((u) => { if (u.docChanged) dirty.value = true; }),
    ],
  });
  if (view) view.setState(state);
  else view = new EditorView({ state, parent: editorEl.value });
}

async function save() {
  if (!activePath.value || !view) return;
  saving.value = true; error.value = '';
  try {
    const res = await fetch(`/api/projects/${projectId.value}/files/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: activePath.value, content: view.state.doc.toString(), feature_id: featureId.value || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Save failed');
    dirty.value = false;
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function reloadRoot() {
  loadingTree.value = true;
  roots.value = await listDir('');
  loadingTree.value = false;
}

onMounted(() => { if (mode.value === 'full') initFullEditor(); else reloadRoot(); });
watch(featureId, () => { if (mode.value === 'full') return; activePath.value = null; dirty.value = false; reloadRoot(); });
onBeforeUnmount(() => { if (view) { view.destroy(); view = null; } });
</script>

<style scoped>
.files-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.files-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0; gap: 8px;
}
.files-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em;
  color: var(--jg-text-faint); display: flex; align-items: center; gap: 8px;
}
.files-scope { text-transform: none; letter-spacing: 0; font-weight: 400; font-family: var(--font-mono); color: var(--jg-text-muted); font-size: 10px; }
.files-actions { display: flex; align-items: center; gap: 10px; }
.files-path { font-size: 11px; font-family: var(--font-mono); color: var(--jg-text-muted); }
.files-dirty { color: var(--jg-orange); }
.f-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
  background: var(--jg-hover); color: var(--jg-text-muted);
  border: 1px solid var(--jg-border); border-radius: var(--radius); transition: all 0.15s;
}
.f-btn:hover:not(:disabled) { color: var(--jg-text); }
.f-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.f-btn--save:hover:not(:disabled) { color: var(--jg-green); border-color: var(--jg-green); }
.files-error { color: var(--jg-red); font-size: 12px; margin: 8px 16px 0; }

.files-body { flex: 1; display: flex; overflow: hidden; }
.files-tree {
  width: 260px; flex-shrink: 0; border-right: 1px solid var(--jg-border);
  overflow: auto; padding: 6px 0;
}
.files-tree-loading { font-size: 11px; color: var(--jg-text-faint); padding: 8px; }
.files-editor { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.files-placeholder {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--jg-text-faint); font-size: 12px;
}
.files-placeholder .pi { font-size: 24px; }
.cm-host { flex: 1; overflow: hidden; }
.cm-host :deep(.cm-editor) { height: 100%; font-size: 12px; }
.cm-host :deep(.cm-scroller) { font-family: var(--font-mono); }

/* Full (openvscode) */
.code-full { height: 100%; overflow: hidden; }
.code-iframe { width: 100%; height: 100%; border: none; display: block; background: var(--jg-bg); }
</style>
