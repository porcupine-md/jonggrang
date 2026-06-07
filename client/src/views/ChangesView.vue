<template>
  <div class="changes-root">
    <div class="changes-toolbar">
      <div class="changes-title">
        <i class="pi pi-file-export" /> Changes
        <span v-if="branch" class="changes-branch"><i class="pi pi-code-branch" /> {{ branch }}</span>
      </div>
      <div class="changes-actions">
        <button class="chg-btn" :disabled="loading" @click="loadFiles" title="Refresh">
          <i class="pi pi-refresh" />
        </button>
        <button
          class="chg-btn chg-btn--push"
          :disabled="pushing || pushed || !files.length"
          @click="push"
        >
          <i class="pi pi-cloud-upload" /> {{ pushed ? 'Pushed' : (pushing ? 'Pushing…' : 'Push') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="changes-error">{{ error }}</p>
    <p v-if="notice" class="changes-notice">{{ notice }}</p>

    <div v-if="!files.length && !loading && !error" class="changes-empty">
      <i class="pi pi-file" />
      <p>No changes in this plan's worktree yet.</p>
    </div>

    <div v-else class="changes-body">
      <div class="changes-files">
        <button
          v-for="f in files" :key="f.file"
          class="chg-file" :class="{ active: activeFile === f.file }"
          @click="loadFile(f.file)"
        >
          <span class="chg-stat" :class="`cs--${f.status}`">{{ f.status }}</span>
          <span class="chg-fname">{{ f.file }}</span>
        </button>
      </div>
      <pre class="changes-diff">{{ loading ? 'Loading…' : (diffContent || 'Select a file to view its diff.') }}</pre>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useOrchestrationStore } from '../stores/orchestration.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId);
const orch = useOrchestrationStore();

const branch = ref('');
const files = ref([]);
const activeFile = ref(null);
const diffContent = ref('');
const loading = ref(false);
const pushing = ref(false);
const error = ref('');
const notice = ref('');

const group = computed(() => orch.groups[featureId.value] || null);
const pushed = computed(() => !!group.value?.pushed || locallyPushed.value);
const locallyPushed = ref(false);

const base = () => `/api/projects/${projectId.value}/orchestration/groups/${featureId.value}`;

async function loadFiles() {
  loading.value = true; error.value = '';
  try {
    const res = await fetch(`${base()}/diff`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to load changes');
    branch.value = data.branch || '';
    files.value = data.files || [];
    if (activeFile.value && !files.value.some(f => f.file === activeFile.value)) {
      activeFile.value = null;
      diffContent.value = '';
    }
  } catch (e) {
    error.value = e.message;
    files.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadFile(file) {
  activeFile.value = file; loading.value = true; diffContent.value = '';
  try {
    const res = await fetch(`${base()}/diff?file=${encodeURIComponent(file)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to load diff');
    diffContent.value = data.diff || '(no diff)';
  } catch (e) {
    diffContent.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function push() {
  pushing.value = true; error.value = ''; notice.value = '';
  try {
    const res = await fetch(`${base()}/push`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Push failed');
    locallyPushed.value = true;
    orch.onGroupPushed({ feature_id: featureId.value });
    notice.value = `Branch ${data.branch} pushed to origin`;
  } catch (e) {
    error.value = e.message;
  } finally {
    pushing.value = false;
  }
}

onMounted(loadFiles);
</script>

<style scoped>
.changes-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.changes-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--jg-border);
  flex-shrink: 0; gap: 8px;
}
.changes-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--jg-text-faint);
  display: flex; align-items: center; gap: 8px;
}
.changes-branch {
  font-size: 11px; font-family: monospace; text-transform: none; letter-spacing: 0;
  color: var(--jg-text-muted); display: flex; align-items: center; gap: 4px; font-weight: 400;
}
.changes-actions { display: flex; gap: 8px; }

.chg-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; font-size: 12px; font-family: inherit; cursor: pointer;
  background: var(--jg-hover); color: var(--jg-text-muted);
  border: 1px solid var(--jg-border); border-radius: var(--radius); transition: all 0.15s;
}
.chg-btn:hover:not(:disabled) { background: var(--jg-card); color: var(--jg-text); }
.chg-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.chg-btn--push:hover:not(:disabled) { color: var(--jg-green); border-color: var(--jg-green); }

.changes-error { color: var(--jg-red); font-size: 12px; margin: 8px 16px 0; }
.changes-notice { color: var(--jg-green); font-size: 12px; margin: 8px 16px 0; }

.changes-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; flex: 1; color: var(--jg-text-faint); font-size: 12px;
}
.changes-empty .pi { font-size: 24px; }

.changes-body { flex: 1; display: flex; overflow: hidden; }
.changes-files {
  width: 260px; flex-shrink: 0; border-right: 1px solid var(--jg-border);
  overflow: auto; padding: 6px;
}
.chg-file {
  display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
  background: none; border: none; cursor: pointer; padding: 6px 8px;
  border-radius: var(--radius); color: var(--jg-text-muted); font-size: 11px;
}
.chg-file:hover { background: var(--jg-hover); }
.chg-file.active { background: var(--jg-hover); color: var(--jg-text); }
.chg-stat { font-family: monospace; font-weight: 700; font-size: 10px; width: 14px; flex-shrink: 0; }
.cs--A { color: var(--jg-green); }
.cs--M { color: #f59e0b; }
.cs--D { color: var(--jg-red); }
.chg-fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.changes-diff {
  flex: 1; overflow: auto; margin: 0; padding: 12px;
  font-size: 11px; font-family: monospace; color: var(--jg-text-muted); white-space: pre;
}
</style>
