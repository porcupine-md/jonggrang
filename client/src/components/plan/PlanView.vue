<template>
  <div class="plan-view">
    <!-- Idle state -->
    <div v-if="state === 'idle'" class="plan-empty">
      <i class="pi pi-file-edit plan-empty-icon" />
      <div class="plan-empty-title">No active plan</div>
      <div class="plan-empty-desc">Describe the feature you want to build</div>
      <div class="plan-form">
        <Textarea
          v-model="description"
          placeholder="e.g. Add user authentication with JWT tokens and refresh token rotation"
          rows="3"
          fluid
          @keydown.ctrl.enter="generatePlan"
        />
        <div class="plan-form-footer">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--jg-text-faint);">
            <input type="checkbox" v-model="deep" style="flex-shrink:0" />
            Deep analysis (slower, more thorough)
          </label>
          <Button :disabled="!description.trim() || generating" @click="generatePlan">
            <i class="pi pi-sparkles" /> {{ generating ? 'Generating...' : 'Generate Plan' }}
          </Button>
        </div>
        <div v-if="genError" class="error-text">{{ genError }}</div>
      </div>
    </div>

    <!-- Draft state: editor -->
    <div v-else-if="state === 'draft'" class="plan-editor-wrap">
      <div class="plan-editor-header">
        <div class="plan-editor-title">Review Plan</div>
        <div class="plan-editor-actions">
          <Button label="Discard" severity="secondary" size="small" @click="discardPlan" />
          <Button size="small" :disabled="approving" @click="approvePlan">
            <i class="pi pi-check" /> {{ approving ? 'Approving...' : 'Approve & Decompose' }}
          </Button>
        </div>
      </div>
      <div class="plan-editor-body">
        <div class="plan-pane">
          <div class="pane-label">Edit</div>
          <Textarea
            class="plan-textarea"
            v-model="planContent"
            fluid
            @input="dirty = true"
          />
        </div>
        <div class="plan-pane">
          <div class="pane-label">Preview</div>
          <div class="plan-preview" v-html="renderedPlan"></div>
        </div>
      </div>
      <div class="plan-editor-footer">
        <span class="plan-mtime" v-if="planMtime">Last saved {{ formatTime(planMtime) }}</span>
        <Button v-if="dirty" label="Save draft" severity="secondary" size="small" @click="savePlan" />
      </div>
    </div>

    <!-- tasks_pending / done / working: show form to plan next feature -->
    <div v-else-if="state === 'tasks_pending' || state === 'done' || state === 'working'" class="plan-empty">
      <i class="plan-empty-icon" :class="state === 'done' ? 'pi pi-check-circle' : state === 'working' ? 'pi pi-cog' : 'pi pi-list-check'" />
      <div class="plan-empty-title">{{ state === 'done' ? 'Feature done' : state === 'working' ? 'Work in progress' : 'Tasks ready' }}</div>
      <div class="plan-empty-desc">Plan the next feature while current tasks run.</div>
      <RouterLink :to="`/projects/${projectId}/tasks`" style="margin-top:12px;margin-bottom:20px">
        <Button label="View Tasks" severity="secondary" icon="pi pi-arrow-right" iconPos="right" />
      </RouterLink>
      <div class="plan-form" style="text-align:left">
        <Textarea
          v-model="description"
          placeholder="Describe the next feature to plan..."
          rows="3"
          fluid
          @keydown.ctrl.enter="generatePlan"
        />
        <div class="plan-form-footer">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--jg-text-faint);">
            <input type="checkbox" v-model="deep" style="flex-shrink:0" />
            Deep analysis
          </label>
          <Button :disabled="!description.trim() || generating" @click="generatePlan">
            <i class="pi pi-sparkles" /> {{ generating ? 'Generating...' : 'Generate Plan' }}
          </Button>
        </div>
        <div v-if="genError" class="error-text">{{ genError }}</div>
      </div>
    </div>

    <!-- Log stream overlay while generating -->
    <div v-if="generating || approving" class="gen-log">
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
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
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
.plan-empty-icon { font-size: 40px; color: var(--jg-green); }
.plan-empty-title { font-size: 16px; color: var(--jg-text); font-weight: 600; }
.plan-empty-desc { font-size: 12px; color: var(--jg-text-muted); }

.plan-form { width: 100%; max-width: 560px; margin-top: 12px; }
.plan-form-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }

.plan-editor-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.plan-editor-header {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 12px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.plan-editor-title { font-weight: 600; font-size: 13px; color: var(--jg-text); }
.plan-editor-actions { display: flex; gap: 8px; }
.plan-editor-body { display: flex; flex: 1; gap: 12px; margin-top: 12px; overflow: hidden; }
.plan-pane { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.pane-label { font-size: 10px; color: var(--jg-text-faint); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
.plan-textarea { flex: 1; resize: none; font-size: 13px; min-height: 0; height: 100%; }
.plan-preview {
  flex: 1; overflow-y: auto; background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 12px; font-size: 13px; color: var(--jg-text); line-height: 1.6;
}
.plan-preview :deep(h1), .plan-preview :deep(h2), .plan-preview :deep(h3) { color: var(--jg-text); margin: 12px 0 6px; }
.plan-preview :deep(p) { margin-bottom: 8px; }
.plan-preview :deep(ul), .plan-preview :deep(ol) { padding-left: 20px; margin-bottom: 8px; }
.plan-preview :deep(code) { background: var(--jg-hover); padding: 2px 4px; border-radius: 0px; color: var(--jg-green); }
.plan-preview :deep(pre) { background: var(--jg-card); padding: 10px; border-radius: var(--radius); overflow-x: auto; margin-bottom: 8px; }
.plan-editor-footer { display: flex; justify-content: space-between; align-items: center; padding-top: 8px; flex-shrink: 0; }
.plan-mtime { font-size: 11px; color: var(--jg-text-faint); }

.gen-log {
  flex-shrink: 0; max-height: 180px; margin-top: 12px; overflow: hidden; display: flex; flex-direction: column;
  background: var(--jg-card); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 16px;
}
.gen-log-title { font-size: 11px; color: var(--jg-text-muted); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.gen-log-body { overflow-y: auto; flex: 1; font-size: 11px; color: var(--jg-text-muted); }
.gen-log-line { line-height: 1.5; }
</style>
