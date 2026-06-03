<template>
  <div class="orch-root">
    <header class="orch-head">
      <div class="orch-head-left">
        <h2 class="orch-title">Parallel Orchestration</h2>
        <p class="orch-sub">Each plan runs in its own git worktree + branch, in parallel. Review changes per plan, then push each branch.</p>
      </div>
      <div class="orch-head-actions">
        <button
          class="orch-btn orch-btn--base"
          :disabled="pushingBase || !base.has_remote"
          :title="base.has_remote ? 'Commit plans/tasks to the base branch and push' : 'No remote configured'"
          @click="pushBase"
        >
          <i class="pi pi-cloud-upload" /> {{ pushingBase ? 'Pushing…' : `Push plans → ${base.branch || 'main'}` }}
        </button>
        <span v-if="orch.hasRun" class="orch-status" :class="`os--${orch.status}`">{{ orch.status }}</span>
        <button v-if="!orch.running" class="orch-btn orch-btn--primary" :disabled="busy" @click="start">
          <i class="pi pi-play" /> Start parallel run
        </button>
        <button v-else class="orch-btn orch-btn--stop" @click="cancel">
          <i class="pi pi-stop" /> Cancel
        </button>
      </div>
    </header>

    <p v-if="error" class="orch-error">{{ error }}</p>
    <p v-if="notice" class="orch-notice">{{ notice }}</p>

    <div v-if="!orch.hasRun" class="orch-empty">
      <i class="pi pi-sitemap" />
      <p>No parallel run yet. Detected plans become isolated worktrees when you start.</p>
    </div>

    <div v-else class="orch-grid">
      <article v-for="g in orch.groupList" :key="g.featureId" class="plan-card" :class="`pc--${g.status}`">
        <div class="pc-top">
          <span class="pc-dot" :class="`pcd--${g.status}`"></span>
          <span class="pc-title" :title="g.title">{{ g.title }}</span>
          <span class="pc-status">{{ g.status }}</span>
        </div>
        <div class="pc-branch"><i class="pi pi-code-branch" /> {{ g.branch }}</div>
        <div class="pc-meta">
          <span>{{ g.taskIds.length }} task{{ g.taskIds.length === 1 ? '' : 's' }}</span>
          <span v-if="g.committed" class="pc-tag pc-tag--ok">committed</span>
          <span v-if="g.pushed" class="pc-tag pc-tag--pushed">pushed</span>
        </div>

        <pre v-if="g.log.length" class="pc-log">{{ g.log.slice(-6).join('\n') }}</pre>
        <div v-if="g.error" class="pc-err">{{ g.error }}</div>

        <div class="pc-actions">
          <button class="orch-btn" @click="openDiff(g)">
            <i class="pi pi-file" /> View changes
          </button>
          <button
            class="orch-btn orch-btn--push"
            :disabled="g.status !== 'completed' || g.pushed || pushing === g.featureId"
            @click="push(g)"
          >
            <i class="pi pi-cloud-upload" /> {{ g.pushed ? 'Pushed' : (pushing === g.featureId ? 'Pushing…' : 'Push') }}
          </button>
        </div>
      </article>
    </div>

    <!-- Diff drawer -->
    <div v-if="diff.open" class="diff-scrim" @click.self="diff.open = false">
      <aside class="diff-panel">
        <div class="diff-head">
          <div>
            <div class="diff-title">{{ diff.title }}</div>
            <div class="diff-branch"><i class="pi pi-code-branch" /> {{ diff.branch }}</div>
          </div>
          <button class="diff-close" @click="diff.open = false"><i class="pi pi-times" /></button>
        </div>
        <div class="diff-body">
          <div class="diff-files">
            <div v-if="!diff.files.length" class="diff-empty">No changes detected.</div>
            <button
              v-for="f in diff.files" :key="f.file"
              class="diff-file" :class="{ active: diff.file === f.file }"
              @click="loadFile(f.file)"
            >
              <span class="diff-stat" :class="`ds--${f.status}`">{{ f.status }}</span>
              <span class="diff-fname">{{ f.file }}</span>
            </button>
          </div>
          <pre class="diff-content">{{ diff.loading ? 'Loading…' : (diff.content || 'Select a file to view its diff.') }}</pre>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useOrchestrationStore } from '../stores/orchestration.js';
import { useWsStore } from '../stores/ws.js';
import { useJonggrangApi } from '../composables/useJonggrangApi.js';

const route = useRoute();
const orch = useOrchestrationStore();
const ws = useWsStore();
const { requestJson } = useJonggrangApi();

const busy = ref(false);
const pushing = ref(null);
const pushingBase = ref(false);
const base = reactive({ branch: 'main', has_remote: false, dirty: false });
const error = ref('');
const notice = ref('');
const diff = reactive({ open: false, featureId: null, title: '', branch: '', files: [], file: null, content: '', loading: false });

const pid = () => route.params.id;

async function refresh() {
  try {
    const view = await requestJson(`/api/projects/${pid()}/orchestration`);
    if (view && Array.isArray(view.groups) && view.groups.length) orch.hydrate(view);
  } catch { /* idle */ }
  try {
    const b = await requestJson(`/api/projects/${pid()}/base`);
    if (b) Object.assign(base, b);
  } catch { /* ignore */ }
}

async function pushBase() {
  pushingBase.value = true; error.value = ''; notice.value = '';
  try {
    const res = await requestJson(`/api/projects/${pid()}/base/push`, { method: 'POST' });
    notice.value = `Plans pushed to ${res.branch}${res.committed ? ' (new commit)' : ' (up to date)'}`;
    base.dirty = false;
  } catch (e) {
    error.value = e.message || 'Failed to push plans';
  } finally {
    pushingBase.value = false;
  }
}

onMounted(() => {
  orch.setProject(pid());
  ws.subscribe(pid());
  refresh();
});

watch(() => route.params.id, (id) => {
  orch.setProject(id);
  ws.subscribe(id);
  refresh();
});

async function start() {
  busy.value = true; error.value = '';
  try {
    const res = await requestJson(`/api/projects/${pid()}/orchestration/start`, { method: 'POST' });
    if (res?.run) orch.onStarted(res.run);
  } catch (e) {
    error.value = e.message || 'Failed to start run';
  } finally {
    busy.value = false;
  }
}

async function cancel() {
  try { await requestJson(`/api/projects/${pid()}/orchestration/cancel`, { method: 'POST' }); }
  catch (e) { error.value = e.message; }
}

async function openDiff(g) {
  Object.assign(diff, { open: true, featureId: g.featureId, title: g.title, branch: g.branch, files: [], file: null, content: '', loading: true });
  try {
    const res = await requestJson(`/api/projects/${pid()}/orchestration/groups/${g.featureId}/diff`);
    diff.files = res.files || [];
  } catch (e) {
    diff.content = e.message || 'Failed to load changes';
  } finally {
    diff.loading = false;
  }
}

async function loadFile(file) {
  diff.file = file; diff.loading = true; diff.content = '';
  try {
    const res = await requestJson(`/api/projects/${pid()}/orchestration/groups/${diff.featureId}/diff?file=${encodeURIComponent(file)}`);
    diff.content = res.diff || '(no diff)';
  } catch (e) {
    diff.content = e.message || 'Failed to load diff';
  } finally {
    diff.loading = false;
  }
}

async function push(g) {
  pushing.value = g.featureId; error.value = '';
  try {
    await requestJson(`/api/projects/${pid()}/orchestration/groups/${g.featureId}/push`, { method: 'POST' });
    orch.onGroupPushed({ feature_id: g.featureId });
  } catch (e) {
    error.value = e.message || 'Push failed';
  } finally {
    pushing.value = null;
  }
}
</script>

<style scoped>
.orch-root { flex: 1; overflow: auto; padding: 20px 24px; }
.orch-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; }
.orch-title { font-size: 15px; font-weight: 600; color: var(--jg-text); margin: 0; }
.orch-sub { font-size: 11px; color: var(--jg-text-faint); margin: 4px 0 0; max-width: 520px; }
.orch-head-actions { display: flex; align-items: center; gap: 10px; }
.orch-status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: var(--radius); color: var(--jg-text-faint); border: 1px solid var(--jg-border); }
.os--running { color: var(--jg-green); border-color: var(--jg-green); }
.os--completed { color: var(--jg-green); }
.os--cancelled { color: var(--jg-red); border-color: var(--jg-red); }

.orch-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; font-size: 12px; font-family: inherit; cursor: pointer;
  background: var(--jg-hover); color: var(--jg-text-muted);
  border: 1px solid var(--jg-border); border-radius: var(--radius); transition: all 0.15s;
}
.orch-btn:hover:not(:disabled) { background: var(--jg-card); color: var(--jg-text); }
.orch-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.orch-btn--primary { background: var(--jg-green); color: #000; border-color: var(--jg-green); }
.orch-btn--primary:hover:not(:disabled) { opacity: 0.85; color: #000; }
.orch-btn--stop:hover { color: var(--jg-red); border-color: var(--jg-red); }
.orch-btn--push:hover:not(:disabled) { color: var(--jg-green); border-color: var(--jg-green); }

.orch-error { color: var(--jg-red); font-size: 12px; margin: 0 0 12px; }
.orch-notice { color: var(--jg-green); font-size: 12px; margin: 0 0 12px; }
.orch-btn--base:hover:not(:disabled) { color: var(--jg-green); border-color: var(--jg-green); }
.orch-empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 60px 0; color: var(--jg-text-faint); font-size: 13px; }
.orch-empty .pi { font-size: 28px; }

.orch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.plan-card { background: var(--jg-card); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.pc--running { border-color: color-mix(in oklch, var(--jg-green) 40%, var(--jg-border)); }
.pc--failed  { border-color: color-mix(in oklch, var(--jg-red) 40%, var(--jg-border)); }

.pc-top { display: flex; align-items: center; gap: 8px; }
.pc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--jg-text-faint); }
.pcd--running { background: var(--jg-green); box-shadow: 0 0 5px var(--jg-green); animation: pulse 1s infinite; }
.pcd--completed { background: var(--jg-green); }
.pcd--failed { background: var(--jg-red); }
.pcd--queued { background: #f59e0b; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.pc-title { font-size: 13px; font-weight: 600; color: var(--jg-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.pc-status { font-size: 10px; color: var(--jg-text-faint); text-transform: uppercase; letter-spacing: 0.05em; }
.pc-branch { font-size: 11px; font-family: monospace; color: var(--jg-text-muted); display: flex; align-items: center; gap: 5px; }
.pc-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--jg-text-faint); }
.pc-tag { font-size: 9px; padding: 1px 6px; border-radius: var(--radius); text-transform: uppercase; letter-spacing: 0.04em; }
.pc-tag--ok { background: color-mix(in oklch, var(--jg-green) 14%, transparent); color: var(--jg-green); }
.pc-tag--pushed { background: color-mix(in oklch, var(--jg-green) 22%, transparent); color: var(--jg-green); }
.pc-log { background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 8px; font-size: 10px; font-family: monospace; color: var(--jg-text-muted); max-height: 110px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; }
.pc-err { font-size: 11px; color: var(--jg-red); }
.pc-actions { display: flex; gap: 8px; margin-top: 2px; }

.diff-scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; justify-content: flex-end; z-index: 50; }
.diff-panel { width: 640px; max-width: 92vw; background: var(--jg-card); border-left: 1px solid var(--jg-border); display: flex; flex-direction: column; }
.diff-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 16px; border-bottom: 1px solid var(--jg-border); }
.diff-title { font-size: 13px; font-weight: 600; color: var(--jg-text); }
.diff-branch { font-size: 11px; font-family: monospace; color: var(--jg-text-muted); display: flex; align-items: center; gap: 5px; margin-top: 3px; }
.diff-close { background: none; border: none; color: var(--jg-text-faint); cursor: pointer; font-size: 14px; }
.diff-close:hover { color: var(--jg-text); }
.diff-body { flex: 1; display: flex; overflow: hidden; }
.diff-files { width: 220px; flex-shrink: 0; border-right: 1px solid var(--jg-border); overflow: auto; padding: 6px; }
.diff-empty { font-size: 11px; color: var(--jg-text-faint); padding: 10px; }
.diff-file { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; background: none; border: none; cursor: pointer; padding: 6px 8px; border-radius: var(--radius); color: var(--jg-text-muted); font-size: 11px; }
.diff-file:hover { background: var(--jg-hover); }
.diff-file.active { background: var(--jg-hover); color: var(--jg-text); }
.diff-stat { font-family: monospace; font-weight: 700; font-size: 10px; width: 14px; flex-shrink: 0; }
.ds--A { color: var(--jg-green); }
.ds--M { color: #f59e0b; }
.ds--D { color: var(--jg-red); }
.diff-fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-content { flex: 1; overflow: auto; margin: 0; padding: 12px; font-size: 11px; font-family: monospace; color: var(--jg-text-muted); white-space: pre; }
</style>
