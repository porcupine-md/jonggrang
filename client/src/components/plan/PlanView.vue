<template>
  <div class="plan-view">

    <!-- IDLE: no plans exist -->
    <div v-if="isIdle" class="plan-empty">
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
          <label class="deep-label">
            <input type="checkbox" v-model="deep" />
            Deep analysis
          </label>
          <div style="flex:1" />
          <button class="tool-config-btn" @click="openToolModal">
            <span>{{ TOOLS.find(t => t.value === selectedTool)?.label || 'Configure' }}</span>
            <span v-if="selectedModel" class="tool-config-extra">· {{ selectedModel }}</span>
            <span v-if="selectedEffort" class="tool-config-extra">· {{ selectedEffort }}</span>
            <i class="pi pi-cog" />
          </button>
          <Button :disabled="!description.trim() || generating" @click="generatePlan">
            <i class="pi pi-sparkles" /> {{ generating ? 'Generating...' : 'Generate Plan' }}
          </Button>
        </div>
        <div v-if="genError" class="error-text">{{ genError }}</div>
      </div>
    </div>

    <!-- SPLIT LAYOUT: has plans or currently generating/revising -->
    <div v-else class="plan-split">

      <!-- LEFT: plan list -->
      <div class="plan-list">
        <div class="plan-list-header">
          <span class="plan-list-title">Plans</span>
          <div class="plan-list-actions">
            <button
              class="btn-rebase"
              :disabled="rebasing || !base.has_remote"
              :title="base.has_remote ? `Pull origin/${base.branch || 'main'} into local (no commit)` : 'No remote configured'"
              @click="rebaseBase"
            >
              <i :class="rebasing ? 'pi pi-spin pi-spinner' : 'pi pi-cloud-download'" /> Rebase
            </button>
            <button
              v-if="canAddNewPlan && !showNewPlanForm && !generating"
              class="btn-new-plan"
              @click="openNewPlanForm"
            >+ New</button>
          </div>
        </div>
        <div class="plan-list-items">
          <!-- Generating item -->
          <div v-if="generating" class="plan-item plan-item--active">
            <div class="plan-item-title">{{ description || 'New Plan' }}</div>
            <span class="plan-badge plan-badge--generating"><i class="pi pi-spin pi-spinner" /> generating</span>
          </div>
          <!-- Revising item (draft being revised) -->
          <div v-else-if="revising && selectedPlan" class="plan-item plan-item--active">
            <div class="plan-item-title">{{ selectedPlan.title }}</div>
            <span class="plan-badge plan-badge--generating"><i class="pi pi-spin pi-spinner" /> revising</span>
          </div>
          <!-- Plan items -->
          <div
            v-for="plan in plans"
            :key="plan.id"
            class="plan-item"
            :class="{ 'plan-item--active': selectedPlan?.id === plan.id && !generating && !revising }"
            @click="selectPlan(plan)"
          >
            <div class="plan-item-title">{{ plan.title }}</div>
            <div class="plan-item-badges">
              <span class="plan-badge" :class="`plan-badge--${plan.status}`">{{ plan.status }}</span>
              <span
                v-if="runBadgeOf(plan)"
                class="plan-badge"
                :class="runBadgeOf(plan) === 'live' ? 'plan-badge--run-live' : 'plan-badge--run-failed'"
              >{{ runBadgeOf(plan) }}</span>
            </div>
          </div>
        </div>
        <div class="plan-list-footer">
          <button
            class="btn-push-plans"
            :disabled="pushingBase || !base.has_remote"
            :title="base.has_remote ? 'Commit plans/tasks to the base branch and push' : 'No remote configured'"
            @click="pushBase"
          >
            <i class="pi pi-cloud-upload" /> {{ pushingBase ? 'Pushing…' : `Push plans → ${base.branch || 'main'}` }}
          </button>
          <div v-if="baseNotice" class="base-notice">{{ baseNotice }}</div>
          <div v-if="baseError" class="base-notice base-notice--err">{{ baseError }}</div>
        </div>
      </div>

      <!-- RIGHT: content panel -->
      <div class="plan-content">

        <!-- Progress log: generating / revising / approving -->
        <div v-if="generating || revising || approving" class="plan-log-wrap">
          <div class="plan-log-title">
            <i class="pi pi-spin pi-spinner" />
            {{ generating ? 'Generating plan...' : revising ? 'Revising plan with AI...' : 'Decomposing plan into tasks...' }}
          </div>
          <div ref="genLogRef" class="plan-log-terminal" />
        </div>

        <!-- New plan form -->
        <div v-else-if="showNewPlanForm" class="plan-new-wrap">
          <div class="plan-new-inner">
            <div class="plan-new-header">
              <div class="plan-new-title">New Plan</div>
              <button class="tool-config-btn" @click="openToolModal">
                <span>{{ TOOLS.find(t => t.value === selectedTool)?.label || 'Configure' }}</span>
                <span v-if="selectedModel" class="tool-config-extra">· {{ selectedModel }}</span>
                <span v-if="selectedEffort" class="tool-config-extra">· {{ selectedEffort }}</span>
                <i class="pi pi-cog" />
              </button>
            </div>
            <Textarea
              v-model="description"
              placeholder="Describe the next feature to build..."
              rows="3"
              fluid
              @keydown.ctrl.enter="generatePlan"
            />
            <div class="plan-new-footer">
              <label class="deep-label">
                <input type="checkbox" v-model="deep" />
                Deep analysis
              </label>
              <div style="flex:1" />
              <div style="display:flex;gap:8px">
                <Button severity="secondary" @click="cancelNewPlan">Cancel</Button>
                <Button :disabled="!description.trim()" @click="generatePlan">
                  <i class="pi pi-sparkles" /> Generate Plan
                </Button>
              </div>
            </div>
            <div v-if="genError" class="error-text">{{ genError }}</div>
          </div>
        </div>

        <!-- Draft: TUI Editor -->
        <div v-else-if="selectedPlan?.status === 'draft'" class="plan-editor-wrap">
          <div class="plan-editor-header">
            <span class="plan-editor-title">{{ selectedPlan.title }}</span>
            <div class="plan-editor-actions">
              <Button label="Discard" severity="secondary" @click="discardPlan" />
              <Button
                severity="secondary"
                :class="{ 'btn-active': showChatSidebar }"
                @click="showChatSidebar = !showChatSidebar"
              >
                <i class="pi pi-comments" /> Discuss
              </Button>
              <Button severity="secondary" @click="toggleReviseBar">
                <i class="pi pi-wand-magic-sparkles" /> Revise with AI
              </Button>
              <Button :disabled="approving" @click="approvePlan">
                <i class="pi pi-check" /> {{ approving ? 'Approving...' : 'Approve & Decompose' }}
              </Button>
            </div>
          </div>

          <!-- Editor row: textarea + optional chat sidebar -->
          <div class="plan-editor-row">
            <div class="plan-editor-col">
              <div class="plan-editor-body">
                <Textarea
                  v-model="planContent"
                  class="plan-editor-textarea"
                  fluid
                  @input="onEditorChange"
                />
              </div>

              <!-- Revise bar -->
              <div v-if="showReviseBar" class="revise-bar">
                <input
                  v-model="reviseInstruction"
                  class="revise-input"
                  placeholder="Describe what to change, e.g. 'also add rate limiting and caching'"
                  @keydown.enter="submitRevise"
                  @keydown.escape="showReviseBar = false"
                  ref="reviseInputEl"
                />
                <Button :disabled="!reviseInstruction.trim()" @click="submitRevise">
                  <i class="pi pi-send" /> Revise
                </Button>
                <Button severity="secondary" @click="showReviseBar = false">Cancel</Button>
              </div>

              <div v-if="genError" class="error-text" style="padding:8px 16px">{{ genError }}</div>
            </div>

            <!-- Chat sidebar -->
            <div v-if="showChatSidebar" class="plan-chat-sidebar">
              <div class="chat-sidebar-header">
                <span class="chat-sidebar-title"><i class="pi pi-comments" /> Discuss</span>
                <button class="chat-close-btn" @click="showChatSidebar = false"><i class="pi pi-times" /></button>
              </div>
              <div class="chat-messages" ref="chatMessagesRef">
                <div v-if="chatMessages.length === 0" class="chat-empty">
                  Ask anything about this plan — suggest changes, explore trade-offs, identify risks.
                </div>
                <div
                  v-for="msg in chatMessages"
                  :key="msg.id"
                  :class="['chat-msg', `chat-msg--${msg.role}`]"
                >
                  <div class="chat-msg-content">{{ msg.content }}</div>
                  <button
                    v-if="msg.role === 'assistant'"
                    class="chat-apply-btn"
                    title="Use this as a revision instruction"
                    @click="applyAsRevision(msg.content)"
                  ><i class="pi pi-pencil" /> Apply as Revision</button>
                </div>
                <div v-if="chatLoading" class="chat-msg chat-msg--loading">
                  <i class="pi pi-spin pi-spinner" /> Thinking...
                </div>
              </div>
              <div class="chat-input-row">
                <textarea
                  v-model="chatInput"
                  class="chat-input"
                  placeholder="Ask about this plan… (Ctrl+Enter to send)"
                  rows="2"
                  @keydown.ctrl.enter="sendChat"
                />
                <Button :disabled="!chatInput.trim() || chatLoading" @click="sendChat">
                  <i class="pi pi-send" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <!-- Read-only: archived/approved/done plan -->
        <div v-else-if="selectedPlan" class="plan-viewer-wrap">
          <div class="plan-viewer-header">
            <span class="plan-viewer-title">{{ selectedPlan.title }}</span>
            <span class="plan-badge" :class="`plan-badge--${selectedPlan.status}`">{{ selectedPlan.status }}</span>
            <RouterLink
              v-if="selectedPlan.id !== 'draft'"
              :to="`/projects/${projectId}/plans/${selectedPlan.id}/pipeline`"
              style="margin-left:auto"
            >
              <Button>
                Work Mode <i class="pi pi-arrow-right" />
              </Button>
            </RouterLink>
          </div>
          <div class="plan-viewer-body">
            <div class="md-content" v-html="renderedContent" />
          </div>
        </div>

        <!-- Nothing selected -->
        <div v-else class="plan-empty-pick">
          <i class="pi pi-arrow-left" style="font-size:20px;color:var(--jg-text-faint)" />
          <span>Select a plan from the list</span>
        </div>

      </div>
    </div>
  </div>

  <!-- Tool / Model / Effort config modal -->
  <Dialog v-model:visible="showToolModal" modal header="Model & Effort" :style="{width:'380px'}" :draggable="false">
    <div class="tool-modal-body">
      <div class="tool-modal-row">
        <label class="tool-modal-label">Tool</label>
        <Select v-model="selectedTool" :options="TOOLS" optionLabel="label" optionValue="value" placeholder="Default" class="tool-modal-select" />
      </div>
      <div v-if="selectedTool" class="tool-modal-row">
        <label class="tool-modal-label">Model</label>
        <Select
          v-if="availableModels.length"
          v-model="selectedModel"
          :options="availableModels"
          optionLabel="label"
          optionValue="value"
          placeholder="Default"
          filter
          class="tool-modal-select"
        />
        <input v-else v-model="selectedModel" class="tool-modal-input" placeholder="Default (from jonggrang.json)" />
      </div>
      <div v-if="selectedTool && availableEfforts.length" class="tool-modal-row">
        <label class="tool-modal-label">Effort</label>
        <Select
          v-model="selectedEffort"
          :options="availableEfforts"
          optionLabel="label"
          optionValue="value"
          placeholder="Default"
          class="tool-modal-select"
        />
      </div>
    </div>
  </Dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import Dialog from 'primevue/dialog';
import { marked } from 'marked';
import { useLogTerminal } from '../../composables/useLogTerminal.js';
import { useProjectsStore } from '../../stores/projects.js';
import { useWsStore } from '../../stores/ws.js';
import { useOrchestrationStore } from '../../stores/orchestration.js';

const route = useRoute();
const projectId = computed(() => route.params.id);
const projects = useProjectsStore();
const ws = useWsStore();
const orch = useOrchestrationStore();

const project = computed(() => projects.byId[projectId.value]);
const state = computed(() => project.value?.derived_state?.state || 'idle');

// Plan list
const plans = ref([]);
const selectedPlan = ref(null);

// Form state
const description = ref('');
const deep = ref(false);
const showNewPlanForm = ref(false);

// Tool / model / effort
const selectedTool = ref(null);
const selectedModel = ref(null);
const selectedEffort = ref(null);
const showToolModal = ref(false);
const availableModels = ref([]);
const availableEfforts = ref([]);
const loadingModels = ref(false);

const TOOLS = [
  { label: 'OpenCode',      value: 'opencode' },
  { label: 'Claude Code',   value: 'claude' },
  { label: 'OpenAI Codex',  value: 'codex' },
  { label: 'Jonggrang (Pi)', value: 'jonggrang' },
];

// Process state
const generating = ref(false);
const approving = ref(false);
const revising = ref(false);
const genLog = ref('');
const genError = ref('');

// xterm for progress log
const genLogStr = computed(() => genLog.value);
const { logContainerRef: genLogRef } = useLogTerminal(genLogStr);

// Editor state
const planContent = ref('');
const planMtime = ref(null);
const dirty = ref(false);

// Revise bar
const showReviseBar = ref(false);
const reviseInstruction = ref('');
const reviseInputEl = ref(null);

// Chat sidebar
const showChatSidebar = ref(false);
const chatMessages = ref([]);
const chatInput = ref('');
const chatLoading = ref(false);
const chatMessagesRef = ref(null);

// Rendered markdown for viewer
const renderedContent = computed(() => {
  const plan = selectedPlan.value;
  if (!plan) return '';
  return marked.parse(plan.content || '');
});

const renderedDraftContent = computed(() => marked.parse(planContent.value || ''));

// Computed
const isIdle = computed(() =>
  plans.value.length === 0 && !generating.value && !showNewPlanForm.value
);

const canAddNewPlan = computed(() => {
  if (['tasks_pending', 'working', 'done'].includes(state.value)) return true;
  return plans.value.length > 0 && plans.value.every(p => p.status === 'done');
});

// Run badge per plan: live orchestration store first, API snapshot as fallback.
// Only surface states the plan status badge doesn't already cover.
function runBadgeOf(plan) {
  if (plan.id === 'draft') return null;
  const s = orch.groups[plan.id]?.status || plan.run_status;
  if (s === 'running' || s === 'queued') return 'live';
  if (s === 'failed' && plan.status !== 'failed') return 'failed';
  return null;
}

// Base branch push (plans/tasks state → main)
const base = reactive({ branch: 'main', has_remote: false, dirty: false });
const pushingBase = ref(false);
const baseNotice = ref('');
const baseError = ref('');
const rebasing = ref(false);

async function loadBase() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/base`);
    if (res.ok) Object.assign(base, await res.json());
  } catch {}
}

async function pushBase() {
  pushingBase.value = true; baseNotice.value = ''; baseError.value = '';
  try {
    const res = await fetch(`/api/projects/${projectId.value}/base/push`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to push plans');
    baseNotice.value = `Plans pushed to ${data.branch}` +
      `${data.committed ? ' (new commit' : ' (up to date'}${data.rebased ? ', rebased on origin)' : ')'}`;
    base.dirty = false;
  } catch (e) {
    baseError.value = e.message;
  } finally {
    pushingBase.value = false;
  }
}

// Pull remote base branch into local (fetch + rebase, no commit).
async function rebaseBase() {
  rebasing.value = true; baseNotice.value = ''; baseError.value = '';
  try {
    const res = await fetch(`/api/projects/${projectId.value}/base/pull`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Rebase failed');
    baseNotice.value = data.updated
      ? `Rebased local ${data.branch} onto origin/${data.branch}`
      : `${data.branch} already up to date with origin`;
    loadBase();
    loadPlans();
  } catch (e) {
    baseError.value = e.message;
  } finally {
    rebasing.value = false;
  }
}

// Load plan list
async function loadPlans() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/plans`);
    if (!res.ok) return;
    const data = await res.json();
    plans.value = data;
    // Auto-select first item (draft takes priority)
    if (!selectedPlan.value && data.length > 0) {
      selectPlan(data[0]);
    } else if (selectedPlan.value) {
      // refresh selected plan data
      const updated = data.find(p => p.id === selectedPlan.value.id);
      if (updated) selectPlan(updated);
      else if (data.length > 0) selectPlan(data[0]);
      else selectedPlan.value = null;
    }
  } catch {}
}

function selectPlan(plan) {
  selectedPlan.value = plan;
  if (plan.status === 'draft') {
    planContent.value = plan.content || '';
    dirty.value = false;
  }
  showNewPlanForm.value = false;
  showReviseBar.value = false;
}

function openNewPlanForm() {
  description.value = '';
  deep.value = false;
  genError.value = '';
  showNewPlanForm.value = true;
  selectedPlan.value = null;
}

function cancelNewPlan() {
  showNewPlanForm.value = false;
  if (plans.value.length > 0) selectPlan(plans.value[0]);
}

function onEditorChange() {
  dirty.value = true;
}

function toggleReviseBar() {
  showReviseBar.value = !showReviseBar.value;
  if (showReviseBar.value) {
    nextTick(() => reviseInputEl.value?.focus());
  }
}

async function loadModels(tool, { resetSelection = false } = {}) {
  if (!tool) { availableModels.value = []; availableEfforts.value = []; return; }
  loadingModels.value = true;
  try {
    const res = await fetch(`/api/models?tool=${encodeURIComponent(tool)}`);
    if (res.ok) {
      const data = await res.json();
      availableModels.value = data.models || [];
      availableEfforts.value = (data.efforts || []).map(e => ({ label: e, value: e }));
    }
  } catch {}
  loadingModels.value = false;
  if (resetSelection) { selectedModel.value = null; selectedEffort.value = null; }
}

async function openToolModal() {
  if (selectedTool.value) await loadModels(selectedTool.value);
  showToolModal.value = true;
}

async function loadProjectTool() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/settings`);
    if (res.ok) {
      const data = await res.json();
      const tool = data.jonggrang_config?.tool || null;
      if (tool) selectedTool.value = tool;
    }
  } catch {}
}

async function generatePlan() {
  if (!description.value.trim() || generating.value) return;
  genError.value = '';
  genLog.value = '';
  generating.value = true;
  showNewPlanForm.value = false;
  try {
    const body = { description: description.value, deep: deep.value };
    if (selectedTool.value)   body.tool   = selectedTool.value;
    if (selectedModel.value)  body.model  = selectedModel.value;
    if (selectedEffort.value) body.effort = selectedEffort.value;
    const res = await fetch(`/api/projects/${projectId.value}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

async function submitRevise() {
  if (!reviseInstruction.value.trim() || revising.value) return;
  genError.value = '';
  genLog.value = '';
  revising.value = true;
  showReviseBar.value = false;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/plan/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: reviseInstruction.value }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Failed to revise');
    }
    reviseInstruction.value = '';
  } catch (e) {
    genError.value = e.message;
    revising.value = false;
  }
}

async function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg || chatLoading.value) return;
  const id = Date.now();
  chatMessages.value.push({ id, role: 'user', content: msg });
  chatInput.value = '';
  chatLoading.value = true;
  try {
    const history = chatMessages.value.slice(0, -1);
    const res = await fetch(`/api/projects/${projectId.value}/plan/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, history }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Chat failed');
    chatMessages.value.push({ id: id + 1, role: 'assistant', content: data.content });
  } catch (e) {
    chatMessages.value.push({ id: id + 2, role: 'error', content: e.message });
  }
  chatLoading.value = false;
  await nextTick();
  if (chatMessagesRef.value) chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
}

function applyAsRevision(content) {
  reviseInstruction.value = content.slice(0, 500);
  showReviseBar.value = true;
  nextTick(() => reviseInputEl.value?.focus());
}

async function savePlan() {
  if (!selectedPlan.value) return;
  const content = planContent.value;
  const res = await fetch(`/api/projects/${projectId.value}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, mtime: planMtime.value }),
  });
  if (res.ok) {
    const d = await res.json();
    planMtime.value = d.mtime;
    dirty.value = false;
  }
}

async function discardPlan() {
  if (!confirm('Discard this plan?')) return;
  await fetch(`/api/projects/${projectId.value}/plan`, { method: 'DELETE' });
  selectedPlan.value = null;
  planContent.value = '';
  dirty.value = false;
  await loadPlans();
}

async function approvePlan() {
  if (dirty.value) await savePlan();
  genLog.value = '';
  approving.value = true;
  const res = await fetch(`/api/projects/${projectId.value}/approve`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    genError.value = err.error?.message || 'Approve failed';
    approving.value = false;
  }
}

watch(selectedTool, (tool) => { loadModels(tool, { resetSelection: true }); });
watch(projectId, loadProjectTool);

// WebSocket events
onMounted(async () => {
  await loadPlans();
  await loadProjectTool();
  loadBase();

  // Live run badges: always re-hydrate from the server so a group that
  // finished while on another view doesn't keep a stale "live" badge.
  try {
    const res = await fetch(`/api/projects/${projectId.value}/orchestration`);
    if (res.ok) {
      const view = await res.json();
      if (view && Array.isArray(view.groups) && view.groups.length) orch.hydrate(view);
    }
  } catch {}

  const socket = ws.socket;
  if (!socket) return;

  socket.on('plan.content', ({ project_id, content, mtime }) => {
    if (project_id !== projectId.value) return;
    planContent.value = content;
    planMtime.value = mtime;
    // Reload plan list to reflect status changes
    loadPlans();
  });

  socket.on('plan.deleted', ({ project_id }) => {
    if (project_id !== projectId.value) return;
    planContent.value = '';
    planMtime.value = null;
    dirty.value = false;
    loadPlans();
  });

  socket.on('process.log', ({ project_id, line }) => {
    if (project_id !== projectId.value) return;
    if (generating.value || approving.value || revising.value) {
      genLog.value += (genLog.value ? '\n' : '') + line;
    }
  });

  socket.on('process.exited', ({ project_id, code }) => {
    if (project_id !== projectId.value) return;
    const wasGenerating = generating.value;
    const wasRevising = revising.value;
    const wasApproving = approving.value;
    generating.value = false;
    approving.value = false;
    revising.value = false;
    if (wasApproving && code !== 0) {
      genError.value = 'Approve failed — no new tasks were created. Re-run "Approve & Decompose".';
    }
    if (wasGenerating || wasRevising || wasApproving) {
      description.value = '';
      loadPlans();
    }
  });
});

watch(projectId, loadPlans);
</script>

<style scoped>
.plan-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

/* IDLE: centered form */
.plan-empty {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; flex: 1; text-align: center; gap: 8px; padding: 20px;
}
.plan-empty-icon { font-size: 40px; color: var(--jg-green); }
.plan-empty-title { font-size: 16px; color: var(--jg-text); font-weight: 600; }
.plan-empty-desc { font-size: 12px; color: var(--jg-text-muted); }
.plan-form { width: 100%; max-width: 560px; margin-top: 12px; }
.plan-form-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }

/* SPLIT LAYOUT */
.plan-split { display: flex; flex: 1; overflow: hidden; }

/* LEFT: plan list */
.plan-list {
  width: 220px; flex-shrink: 0;
  border-right: 1px solid var(--jg-border);
  display: flex; flex-direction: column; overflow: hidden;
}
.plan-list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--jg-border);
  flex-shrink: 0;
}
.plan-list-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--jg-text-faint); }
.plan-list-actions { display: flex; align-items: center; gap: 6px; }
.btn-new-plan {
  font-family: var(--font-mono); font-size: 11px; font-weight: 500;
  color: var(--jg-green); background: transparent; border: 1px solid var(--jg-green);
  padding: 2px 8px; cursor: pointer; transition: background 0.12s;
}
.btn-new-plan:hover { background: color-mix(in oklch, var(--jg-green) 12%, transparent); }
.btn-rebase {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: var(--font-mono); font-size: 11px; font-weight: 500;
  color: var(--jg-text-muted); background: transparent; border: 1px solid var(--jg-border);
  padding: 2px 8px; cursor: pointer; transition: all 0.12s;
}
.btn-rebase:hover:not(:disabled) { color: var(--jg-cyan); border-color: var(--jg-cyan); }
.btn-rebase:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-rebase .pi { font-size: 10px; }
.plan-list-items { flex: 1; overflow-y: auto; padding: 4px; }

.plan-item {
  padding: 8px 10px; cursor: pointer; border: 1px solid transparent;
  transition: background 0.12s; margin-bottom: 2px;
}
.plan-item:hover { background: var(--jg-hover); }
.plan-item--active { background: color-mix(in oklch, var(--jg-green) 10%, transparent); border-color: color-mix(in oklch, var(--jg-green) 30%, transparent); }
.plan-item-title { font-size: 12px; color: var(--jg-text); line-height: 1.4; display: block; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Status badges */
.plan-item-badges { display: flex; align-items: center; gap: 4px; }
.plan-badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; padding: 1px 5px; }
.plan-badge--run-live { background: color-mix(in oklch, var(--jg-green) 20%, transparent); color: var(--jg-green); animation: livePulse 1.2s infinite; }
.plan-badge--run-failed { background: color-mix(in oklch, var(--jg-red) 15%, transparent); color: var(--jg-red); }
@keyframes livePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }

/* Push plans → base branch */
.plan-list-footer { padding: 8px; border-top: 1px solid var(--jg-border); flex-shrink: 0; }
.btn-push-plans {
  display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%;
  font-family: var(--font-mono); font-size: 10px; padding: 5px 8px; cursor: pointer;
  background: var(--jg-hover); color: var(--jg-text-muted); border: 1px solid var(--jg-border);
  transition: all 0.15s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.btn-push-plans:hover:not(:disabled) { color: var(--jg-green); border-color: var(--jg-green); }
.btn-push-plans:disabled { opacity: 0.4; cursor: not-allowed; }
.base-notice { font-size: 9px; color: var(--jg-green); margin-top: 5px; line-height: 1.4; }
.base-notice--err { color: var(--jg-red); }
.plan-badge--draft { background: color-mix(in oklch, var(--jg-cyan) 15%, transparent); color: var(--jg-cyan); }
.plan-badge--generating { background: color-mix(in oklch, var(--jg-orange) 15%, transparent); color: var(--jg-orange); display: flex; align-items: center; gap: 4px; }
.plan-badge--approved { background: color-mix(in oklch, var(--jg-green) 15%, transparent); color: var(--jg-green); }
.plan-badge--done { background: color-mix(in oklch, var(--jg-green) 15%, transparent); color: var(--jg-green); }
.plan-badge--in_progress { background: color-mix(in oklch, var(--jg-orange) 15%, transparent); color: var(--jg-orange); }
.plan-badge--failed { background: color-mix(in oklch, var(--jg-red) 15%, transparent); color: var(--jg-red); }

/* RIGHT: content panels */
.plan-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

/* Progress log */
.plan-log-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.plan-log-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--jg-text-faint); padding: 8px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
.plan-log-terminal { flex: 1; overflow: hidden; padding: 8px 12px 0; }
.plan-log-terminal :deep(.xterm) { height: 100%; }
.plan-log-terminal :deep(.xterm-viewport) { overflow-y: auto !important; }
.plan-log-terminal :deep(.xterm-screen) { padding-left: 0; }

/* New plan form */
.plan-new-wrap { display: flex; align-items: center; justify-content: center; flex: 1; padding: 20px; }
.plan-new-inner { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 12px; }
.plan-new-title { font-size: 13px; font-weight: 600; color: var(--jg-text); }
.plan-form-footer { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.plan-new-footer { display: flex; align-items: center; gap: 8px; }

/* Draft editor */
.plan-editor-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.plan-editor-header {
  display: flex; align-items: center; gap: 8px; padding: 10px 16px;
  border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.plan-editor-title { font-size: 13px; font-weight: 600; color: var(--jg-text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-editor-actions { display: flex; gap: 6px; flex-shrink: 0; }
.btn-active :deep(.p-button) { border-color: var(--jg-green) !important; color: var(--jg-green) !important; }
.plan-editor-row { display: flex; flex: 1; overflow: hidden; min-height: 0; }
.plan-editor-col { display: flex; flex-direction: column; flex: 1; overflow: hidden; min-height: 0; }
.plan-editor-body { flex: 1; overflow: hidden; min-height: 0; display: flex; flex-direction: column; }
.plan-editor-body :deep(.plan-editor-textarea) { flex: 1; height: 100% !important; resize: none; border: none !important; border-radius: 0 !important; font-size: 13px !important; line-height: 1.7 !important; padding: 16px !important; background: var(--jg-bg) !important; color: var(--jg-text) !important; }
.plan-editor-body :deep(.plan-editor-textarea:focus) { box-shadow: none !important; outline: none !important; }

/* Revise bar */
.revise-bar {
  display: flex; gap: 8px; padding: 10px 16px;
  border-top: 1px solid var(--jg-border); flex-shrink: 0;
  background: color-mix(in oklch, var(--jg-orange) 5%, var(--jg-card));
}
.revise-input {
  flex: 1; font-family: var(--font-mono); font-size: 12px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); padding: 6px 10px; outline: none;
}
.revise-input:focus { border-color: var(--jg-orange); }

/* Chat sidebar */
.plan-chat-sidebar {
  width: 340px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden;
  border-left: 1px solid var(--jg-border);
}
.chat-sidebar-header {
  display: flex; align-items: center; padding: 8px 12px;
  border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
  background: var(--jg-card);
}
.chat-sidebar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--jg-text-faint); flex: 1; display: flex; align-items: center; gap: 6px; }
.chat-close-btn {
  width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  background: none; border: none; color: var(--jg-text-faint); cursor: pointer;
}
.chat-close-btn:hover { color: var(--jg-text); }
.chat-close-btn .pi { font-size: 11px; }
.chat-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.chat-empty { font-size: 11px; color: var(--jg-text-faint); text-align: center; margin: auto; padding: 20px; line-height: 1.6; }
.chat-msg { display: flex; flex-direction: column; gap: 4px; }
.chat-msg--user .chat-msg-content {
  align-self: flex-end; background: color-mix(in oklch, var(--jg-green) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--jg-green) 30%, transparent);
  padding: 6px 10px; font-size: 12px; color: var(--jg-text); max-width: 90%; line-height: 1.5;
}
.chat-msg--assistant .chat-msg-content {
  background: var(--jg-hover); border: 1px solid var(--jg-border);
  padding: 8px 10px; font-size: 12px; color: var(--jg-text); line-height: 1.6; white-space: pre-wrap;
}
.chat-msg--error .chat-msg-content {
  background: color-mix(in oklch, var(--jg-red) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--jg-red) 30%, transparent);
  padding: 6px 10px; font-size: 12px; color: var(--jg-red);
}
.chat-msg--loading { color: var(--jg-text-faint); font-size: 11px; display: flex; align-items: center; gap: 6px; }
.chat-apply-btn {
  align-self: flex-start; font-size: 10px; font-family: var(--font-mono);
  background: none; border: 1px solid var(--jg-border); color: var(--jg-text-faint);
  padding: 2px 7px; cursor: pointer; display: flex; align-items: center; gap: 4px;
  transition: color 0.12s, border-color 0.12s;
}
.chat-apply-btn:hover { color: var(--jg-orange); border-color: var(--jg-orange); }
.chat-apply-btn .pi { font-size: 10px; }
.chat-input-row {
  display: flex; gap: 6px; padding: 8px 10px;
  border-top: 1px solid var(--jg-border); flex-shrink: 0;
  background: var(--jg-card);
}
.chat-input {
  flex: 1; font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); padding: 6px 8px; outline: none; resize: none;
}
.chat-input:focus { border-color: var(--jg-green); }

/* Read-only viewer */
.plan-viewer-wrap { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
.plan-viewer-header {
  display: flex; align-items: center; gap: 8px; padding: 10px 16px;
  border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.plan-viewer-title { font-size: 13px; font-weight: 600; color: var(--jg-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-viewer-body { flex: 1; overflow-y: auto; padding: 20px 24px; }

/* Markdown rendered content */
.md-content { font-size: 13px; color: var(--jg-text); line-height: 1.7; max-width: 760px; }
.md-content :deep(h1) { font-size: 18px; font-weight: 700; margin: 0 0 12px; color: var(--jg-text); }
.md-content :deep(h2) { font-size: 15px; font-weight: 600; margin: 20px 0 8px; color: var(--jg-text); border-bottom: 1px solid var(--jg-border); padding-bottom: 4px; }
.md-content :deep(h3) { font-size: 13px; font-weight: 600; margin: 16px 0 6px; color: var(--jg-text-dim); }
.md-content :deep(p) { margin: 0 0 10px; }
.md-content :deep(ul), .md-content :deep(ol) { margin: 0 0 10px; padding-left: 20px; }
.md-content :deep(li) { margin-bottom: 3px; }
.md-content :deep(code) { font-family: var(--font-mono); font-size: 11px; background: var(--jg-hover); border: 1px solid var(--jg-border); padding: 1px 4px; }
.md-content :deep(pre) { background: var(--jg-hover); border: 1px solid var(--jg-border); padding: 12px; overflow-x: auto; margin: 0 0 12px; }
.md-content :deep(pre code) { background: none; border: none; padding: 0; font-size: 12px; }
.md-content :deep(blockquote) { border-left: 3px solid var(--jg-border); margin: 0 0 10px; padding: 4px 12px; color: var(--jg-text-muted); }
.md-content :deep(hr) { border: none; border-top: 1px solid var(--jg-border); margin: 16px 0; }
.md-content :deep(a) { color: var(--jg-cyan); }
.md-content :deep(strong) { font-weight: 700; }
.md-content :deep(em) { font-style: italic; color: var(--jg-text-dim); }

/* Nothing selected */
.plan-empty-pick { display: flex; align-items: center; justify-content: center; gap: 10px; flex: 1; color: var(--jg-text-faint); font-size: 12px; }

/* Shared */
.deep-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--jg-text-faint); }
.error-text { font-size: 11px; color: var(--jg-red); margin-top: 8px; }

/* Tool config button */
.plan-new-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.tool-config-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 8px; font-family: var(--font-mono); font-size: 11px;
  background: var(--jg-hover); border: 1px solid var(--jg-border);
  color: var(--jg-text-faint); cursor: pointer;
  transition: color 0.12s, border-color 0.12s; white-space: nowrap;
}
.tool-config-btn:hover { color: var(--jg-text); border-color: var(--jg-text-muted); }
.tool-config-btn .pi { font-size: 11px; }
.tool-config-extra { color: var(--jg-green); }

/* Tool modal */
.tool-modal-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
.tool-modal-row { display: flex; align-items: center; gap: 12px; }
.tool-modal-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--jg-text-faint); width: 44px; flex-shrink: 0; }
.tool-modal-select { flex: 1; font-size: 12px !important; }
.tool-modal-select :deep(.p-select) { width: 100%; }
.tool-modal-input {
  flex: 1; height: 32px; padding: 4px 10px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: var(--font-mono); font-size: 12px; outline: none;
}
.tool-modal-input:focus { border-color: var(--jg-green); }
</style>
