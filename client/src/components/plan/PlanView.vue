<template>
  <div class="plan-view">
    <!-- Idle state -->
    <div v-if="state === 'idle'" class="plan-empty">
      <div class="plan-empty-icon">📝</div>
      <div class="plan-empty-title">No active plan</div>
      <div class="plan-empty-desc">Describe the feature you want to build</div>
      <div class="plan-form">
        <textarea
          v-model="description"
          placeholder="e.g. Add user authentication with JWT tokens and refresh token rotation"
          rows="3"
          @keydown.ctrl.enter="generatePlan"
        ></textarea>
        <div class="plan-form-footer">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6b7280;">
            <input type="checkbox" v-model="deep" style="width:auto" />
            Deep analysis (slower, more thorough)
          </label>
          <button class="btn btn--primary" :disabled="!description.trim() || generating" @click="generatePlan">
            {{ generating ? 'Generating...' : '✨ Generate Plan' }}
          </button>
        </div>
        <div v-if="genError" class="error-text">{{ genError }}</div>
      </div>
    </div>

    <!-- Draft state: editor -->
    <div v-else-if="state === 'draft'" class="plan-editor-wrap">
      <div class="plan-editor-header">
        <div class="plan-editor-title">Review Plan</div>
        <div class="plan-editor-actions">
          <button class="btn btn--secondary btn--sm" @click="discardPlan">Discard</button>
          <button class="btn btn--primary btn--sm" :disabled="approving" @click="approvePlan">
            {{ approving ? 'Approving...' : '✓ Approve & Decompose' }}
          </button>
        </div>
      </div>
      <div class="plan-editor-body">
        <div class="plan-pane">
          <div class="pane-label">Edit</div>
          <textarea
            class="plan-textarea"
            v-model="planContent"
            @input="dirty = true"
          ></textarea>
        </div>
        <div class="plan-pane">
          <div class="pane-label">Preview</div>
          <div class="plan-preview" v-html="renderedPlan"></div>
        </div>
      </div>
      <div class="plan-editor-footer">
        <span class="plan-mtime" v-if="planMtime">Last saved {{ formatTime(planMtime) }}</span>
        <button v-if="dirty" class="btn btn--secondary btn--sm" @click="savePlan">Save draft</button>
      </div>
    </div>

    <!-- tasks_pending / done / working: show form to plan next feature -->
    <div v-else-if="state === 'tasks_pending' || state === 'done' || state === 'working'" class="plan-empty">
      <div class="plan-empty-icon">{{ state === 'done' ? '✅' : state === 'working' ? '⚙️' : '📋' }}</div>
      <div class="plan-empty-title">{{ state === 'done' ? 'Feature done' : state === 'working' ? 'Work in progress' : 'Tasks ready' }}</div>
      <div class="plan-empty-desc">Plan the next feature while current tasks run.</div>
      <RouterLink :to="`/projects/${projectId}/tasks`" class="btn btn--secondary" style="margin-top:12px;margin-bottom:20px">View Tasks →</RouterLink>
      <div class="plan-form" style="text-align:left">
        <textarea
          v-model="description"
          placeholder="Describe the next feature to plan..."
          rows="3"
          @keydown.ctrl.enter="generatePlan"
        ></textarea>
        <div class="plan-form-footer">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6b7280;">
            <input type="checkbox" v-model="deep" style="width:auto" />
            Deep analysis
          </label>
          <button class="btn btn--primary" :disabled="!description.trim() || generating" @click="generatePlan">
            {{ generating ? 'Generating...' : '✨ Generate Plan' }}
          </button>
        </div>
        <div v-if="genError" class="error-text">{{ genError }}</div>
      </div>
    </div>

    <!-- Log stream overlay while generating -->
    <div v-if="generating || approving" class="gen-log card">
      <div class="gen-log-title">{{ approving ? 'Decomposing plan...' : 'Generating plan...' }}</div>
      <div class="gen-log-body" ref="logEl">
        <div v-for="(l, i) in genLog" :key="i" class="gen-log-line">{{ l }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useProjectsStore } from '../../stores/projects.js';
import { useWsStore } from '../../stores/ws.js';
import { marked } from 'marked';

const route = useRoute();
const projectId = computed(() => route.params.id);
const projects = useProjectsStore();
const ws = useWsStore();

const project = computed(() => projects.byId[projectId.value]);
const state = computed(() => project.value?.derived_state?.state || 'idle');

const description = ref('');
const deep = ref(false);
const generating = ref(false);
const genError = ref('');
const genLog = ref([]);
const logEl = ref(null);

const planContent = ref('');
const planMtime = ref(null);
const dirty = ref(false);
const approving = ref(false);

const renderedPlan = computed(() => {
  try { return marked.parse(planContent.value || ''); } catch { return planContent.value; }
});

// Load plan content when entering draft state
watch(state, async (s) => {
  if (s === 'draft') await loadPlan();
}, { immediate: true });

// Also listen for plan.content events
onMounted(() => {
  const socket = ws.socket;
  if (!socket) return;
  socket.on('plan.content', ({ project_id, content, mtime }) => {
    if (project_id !== projectId.value) return;
    if (!dirty.value) {
      planContent.value = content;
      planMtime.value = mtime;
    }
  });
  socket.on('plan.deleted', ({ project_id }) => {
    if (project_id !== projectId.value) return;
    planContent.value = '';
    planMtime.value = null;
    dirty.value = false;
  });
  socket.on('process.log', ({ project_id, line }) => {
    if (project_id !== projectId.value) return;
    if (generating.value || approving.value) {
      genLog.value.push(line);
      nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
    }
  });
  socket.on('process.exited', ({ project_id }) => {
    if (project_id !== projectId.value) return;
    generating.value = false;
    approving.value = false;
    if (state.value === 'draft') loadPlan();
  });
});

async function loadPlan() {
  const res = await fetch(`/api/projects/${projectId.value}/plan`);
  if (!res.ok) return;
  const data = await res.json();
  if (data.exists) {
    planContent.value = data.content;
    planMtime.value = data.mtime;
    dirty.value = false;
  }
}

async function generatePlan() {
  genError.value = '';
  genLog.value = [];
  generating.value = true;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: description.value, deep: deep.value }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Failed');
    }
  } catch (e) {
    genError.value = e.message;
    generating.value = false;
  }
}

async function savePlan() {
  const res = await fetch(`/api/projects/${projectId.value}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: planContent.value }),
  });
  if (res.ok) {
    const d = await res.json();
    planMtime.value = d.mtime;
    dirty.value = false;
  }
}

async function approvePlan() {
  if (dirty.value) await savePlan();
  genLog.value = [];
  approving.value = true;
  const res = await fetch(`/api/projects/${projectId.value}/approve`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    genError.value = err.error?.message || 'Approve failed';
    approving.value = false;
  }
}

async function discardPlan() {
  if (!confirm('Discard this plan?')) return;
  await fetch(`/api/projects/${projectId.value}/plan`, { method: 'DELETE' });
  planContent.value = '';
  dirty.value = false;
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString();
}
</script>

<style scoped>
.plan-view { display: flex; flex-direction: column; height: 100%; padding: 20px; overflow: hidden; }

.plan-empty {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; flex: 1; text-align: center; gap: 8px;
}
.plan-empty-icon { font-size: 48px; }
.plan-empty-title { font-size: 18px; color: #f4f4f5; font-weight: 600; }
.plan-empty-desc { font-size: 13px; color: #6b7280; }

.plan-form { width: 100%; max-width: 560px; margin-top: 12px; }
.plan-form textarea { min-height: 80px; resize: vertical; }
.plan-form-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }

.plan-editor-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.plan-editor-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 12px; border-bottom: 1px solid #1e1f2a; flex-shrink: 0;
}
.plan-editor-title { font-weight: 600; font-size: 15px; color: #f4f4f5; }
.plan-editor-actions { display: flex; gap: 8px; }
.plan-editor-body { display: flex; flex: 1; gap: 12px; margin-top: 12px; overflow: hidden; }
.plan-pane { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.pane-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
.plan-textarea { flex: 1; resize: none; font-family: monospace; font-size: 13px; min-height: 0; }
.plan-preview {
  flex: 1; overflow-y: auto; background: #0a0b0f; border: 1px solid #2d2f3e; border-radius: 6px;
  padding: 12px; font-size: 13px; color: #d1d5db; line-height: 1.6;
}
.plan-preview :deep(h1), .plan-preview :deep(h2), .plan-preview :deep(h3) { color: #f4f4f5; margin: 12px 0 6px; }
.plan-preview :deep(p) { margin-bottom: 8px; }
.plan-preview :deep(ul), .plan-preview :deep(ol) { padding-left: 20px; margin-bottom: 8px; }
.plan-preview :deep(code) { background: #1e1f2a; padding: 2px 4px; border-radius: 3px; }
.plan-preview :deep(pre) { background: #1e1f2a; padding: 10px; border-radius: 6px; overflow-x: auto; margin-bottom: 8px; }
.plan-editor-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; flex-shrink: 0; }
.plan-mtime { font-size: 11px; color: #4b5563; }

.gen-log {
  flex-shrink: 0; max-height: 180px; margin-top: 12px; overflow: hidden; display: flex; flex-direction: column;
}
.gen-log-title { font-size: 12px; color: #9ca3af; margin-bottom: 8px; font-weight: 600; }
.gen-log-body { overflow-y: auto; flex: 1; font-family: monospace; font-size: 11px; color: #6b7280; }
.gen-log-line { line-height: 1.5; }

.spinning { animation: spin 2s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
