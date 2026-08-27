<template>
  <div class="plan-view">

    <!-- IDLE: no plans exist -->
    <div v-if="isIdle" class="plan-empty">
      <i class="pi pi-file-edit plan-empty-icon" />
      <div class="plan-empty-title">No active plan</div>
      <div class="plan-empty-desc">Describe the feature you want to build</div>
      <div class="plan-form">
        <div v-if="uploadedFile" class="file-badge">
          <i class="pi pi-file" />
          <span>{{ uploadedFile.name }}</span>
          <button class="file-badge-clear" @click="clearFile" title="Remove file"><i class="pi pi-times" /></button>
        </div>
        <Textarea
          v-model="description"
          :placeholder="uploadedFile ? 'Additional context (optional)...' : 'e.g. Add user authentication with JWT tokens and refresh token rotation'"
          rows="3"
          fluid
          @keydown.ctrl.enter="generatePlan"
        />
        <div class="plan-form-footer">
          <div class="plan-footer-config">
            <label class="deep-label">
              <input type="checkbox" v-model="deep" />
              Deep analysis
            </label>
            <label class="deep-label" title="Branch the worktree is cut from (fetched fresh from origin)">
              base:
              <Select v-model="selectedBase" :options="availableBranches" filter resetFilterOnHide
                      filterPlaceholder="search branch…" scrollHeight="240px"
                      placeholder="base branch" class="base-select" />
            </label>
            <label v-if="baselineOptions.length" class="deep-label" title="Design template / UI baseline to style this plan from (skips the design question)">
              design:
              <Select v-model="selectedBaseline" :options="baselineOptions" optionLabel="label" optionValue="value"
                      filter resetFilterOnHide filterPlaceholder="search design…" scrollHeight="240px"
                      showClear placeholder="auto" class="base-select" />
            </label>
          </div>
          <div class="plan-footer-actions">
            <button v-if="storageConfigured" class="tool-config-btn" @click="triggerUpload" :disabled="uploading" title="Upload a file to storage — inserts a shareable link into the description">
              <i :class="uploading ? 'pi pi-spin pi-spinner' : 'pi pi-cloud-upload'" /> {{ uploading ? 'Uploading…' : 'Upload' }}
            </button>
            <input ref="uploadInputRef" type="file" style="display:none" @change="onUploadChange" />
            <button class="tool-config-btn" @click="triggerFileInput" title="Upload BRD/PRD source file">
              <i class="pi pi-upload" /> BRD/PRD
            </button>
            <input ref="fileInputRef" type="file" style="display:none" @change="onFileChange" />
            <button class="tool-config-btn" @click="openToolModal">
              <span>{{ TOOLS.find(t => t.value === selectedTool)?.label || 'Configure' }}</span>
              <span v-if="selectedModel" class="tool-config-extra">· {{ selectedModel }}</span>
              <span v-if="selectedEffort" class="tool-config-extra">· {{ selectedEffort }}</span>
              <i class="pi pi-cog" />
            </button>
            <Button class="plan-generate-btn" :disabled="(!description.trim() && !uploadedFile) || generating" @click="generatePlan">
              <i class="pi pi-sparkles" /> {{ generating ? 'Generating...' : 'Generate Plan' }}
            </Button>
          </div>
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
              <span v-if="plan.status === 'draft' && plan.mtime" class="plan-age">{{ relativeTime(plan.mtime) }}</span>
              <span
                v-if="runBadgeOf(plan)"
                class="plan-badge"
                :class="runBadgeOf(plan) === 'live' ? 'plan-badge--run-live' : 'plan-badge--run-failed'"
              >{{ runBadgeOf(plan) }}</span>
              <a
                v-if="plan.source_issue"
                class="src-issue-link"
                :href="plan.source_issue.url"
                target="_blank"
                rel="noopener"
                :title="`${plan.source_issue.repo}#${plan.source_issue.number}`"
                @click.stop
              >
                <ProviderIcon :provider="plan.source_issue.provider" :size="10" />#{{ plan.source_issue.number }}
              </a>
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

        <!-- Progress log: generating / revising / approving, or (refresh-only) a
             "questions ready" continuation that precedes the QA dialog. -->
        <div v-if="generating || revising || approving || questionsReady" class="plan-log-wrap">
          <div class="plan-log-title">
            <template v-if="generating || revising || approving">
              <i class="pi pi-spin pi-spinner" />
              {{ generating ? 'Generating plan...' : revising ? 'Revising plan with AI...' : 'Decomposing plan into tasks...' }}
            </template>
            <template v-else>
              <i class="pi pi-check-circle" />
              Plan questions ready — answer them to continue generating
            </template>
          </div>
          <div v-if="generating || revising || approving" ref="genLogRef" class="plan-log-terminal" />
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
            <div v-if="uploadedFile" class="file-badge">
              <i class="pi pi-file" />
              <span>{{ uploadedFile.name }}</span>
              <button class="file-badge-clear" @click="clearFile" title="Remove file"><i class="pi pi-times" /></button>
            </div>
            <Textarea
              v-model="description"
              :placeholder="uploadedFile ? 'Additional context (optional)...' : 'Describe the next feature to build...'"
              rows="3"
              fluid
              @keydown.ctrl.enter="generatePlan"
            />
            <div class="plan-new-footer">
              <div class="plan-footer-config">
                <label class="deep-label">
                  <input type="checkbox" v-model="deep" />
                  Deep analysis
                </label>
                <label class="deep-label" title="Branch the worktree is cut from (fetched fresh from origin)">
                  base:
                  <Select v-model="selectedBase" :options="availableBranches" filter resetFilterOnHide
                          filterPlaceholder="search branch…" scrollHeight="240px"
                          placeholder="base branch" class="base-select" />
                </label>
                <label v-if="baselineOptions.length" class="deep-label" title="Design template / UI baseline to style this plan from (skips the design question)">
                  design:
                  <Select v-model="selectedBaseline" :options="baselineOptions" optionLabel="label" optionValue="value"
                          filter resetFilterOnHide filterPlaceholder="search design…" scrollHeight="240px"
                          showClear placeholder="auto" class="base-select" />
                </label>
              </div>
              <div class="plan-footer-actions">
                <button v-if="storageConfigured" class="tool-config-btn" @click="triggerUpload" :disabled="uploading" title="Upload a file to storage — inserts a shareable link into the description">
                  <i :class="uploading ? 'pi pi-spin pi-spinner' : 'pi pi-cloud-upload'" /> {{ uploading ? 'Uploading…' : 'Upload' }}
                </button>
                <input ref="uploadInputRef" type="file" style="display:none" @change="onUploadChange" />
                <button class="tool-config-btn" @click="triggerFileInput" title="Upload BRD/PRD source file">
                  <i class="pi pi-upload" /> BRD/PRD
                </button>
                <Button severity="secondary" @click="cancelNewPlan">Cancel</Button>
                <Button class="plan-generate-btn" :disabled="!description.trim() && !uploadedFile" @click="generatePlan">
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
                :class="{ 'btn-active': showDiscussPanel }"
                @click="showDiscussPanel = !showDiscussPanel"
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

              <section v-if="selectedPlan.ui" class="ui-context-review">
                <header class="ui-context-header">
                  <div>
                    <div class="ui-context-title">UI planning context</div>
                    <div class="ui-context-path">Review with the plan before approval</div>
                  </div>
                  <div class="ui-context-badges">
                    <span class="ui-context-badge">{{ selectedPlan.ui.guide_status }}</span>
                    <span v-if="selectedPlan.ui.baseline" class="ui-context-badge">{{ selectedPlan.ui.baseline }}</span>
                    <span v-if="selectedPlan.ui.token_status" class="ui-context-badge">tokens: {{ selectedPlan.ui.token_status }}</span>
                  </div>
                </header>

                <details v-if="selectedPlan.ui.handoff_content" open class="ui-context-details">
                  <summary>Feature handoff · {{ selectedPlan.ui.handoff_path }}</summary>
                  <div class="ui-context-markdown" v-html="renderedUiHandoff" />
                </details>

                <details v-if="selectedPlan.ui.guide_content || selectedPlan.ui.current_guide_content" class="ui-context-details">
                  <summary>Project guide {{ selectedPlan.ui.current_guide_content && selectedPlan.ui.guide_content ? 'comparison' : '' }} · {{ selectedPlan.ui.guide_path }}</summary>
                  <div class="ui-guide-compare" :class="{ 'ui-guide-compare--single': !selectedPlan.ui.current_guide_content || !selectedPlan.ui.guide_content }">
                    <div v-if="selectedPlan.ui.current_guide_content" class="ui-guide-version">
                      <div class="ui-guide-version-label">Current</div>
                      <div class="ui-context-markdown" v-html="renderedUiCurrentGuide" />
                    </div>
                    <div v-if="selectedPlan.ui.guide_content" class="ui-guide-version">
                      <div class="ui-guide-version-label">Proposed</div>
                      <div class="ui-context-markdown" v-html="renderedUiGuide" />
                    </div>
                  </div>
                </details>
              </section>

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

            <!-- Discuss panel: interactive PTY session to the selected agent -->
            <PlanDiscuss
              v-if="showDiscussPanel"
              :key="selectedPlan?.sessionId || selectedPlan?.id"
              :project-id="projectId"
              :session-id="selectedPlan?.sessionId || selectedPlan?.id"
              :tool="discussTool"
              @close="showDiscussPanel = false"
            />
          </div>
        </div>

        <!-- Read-only: archived/approved/done plan -->
        <div v-else-if="selectedPlan" class="plan-viewer-wrap">
          <div class="plan-viewer-header">
            <span class="plan-viewer-title">{{ selectedPlan.title }}</span>
            <span class="plan-badge" :class="`plan-badge--${selectedPlan.status}`">{{ selectedPlan.status }}</span>
            <div v-if="selectedPlan.status !== 'draft'" style="margin-left:auto; display:flex; gap:8px;">
              <Button severity="secondary" :disabled="generating" @click="toggleExtendForm">
                <i class="pi pi-plus" /> Extend this plan
              </Button>
              <RouterLink :to="`/projects/${projectId}/plans/${selectedPlan.id}/pipeline`">
                <Button>
                  Work Mode <i class="pi pi-arrow-right" />
                </Button>
              </RouterLink>
            </div>
          </div>
          <div v-if="showExtendForm" class="plan-extend-form">
            <label class="plan-extend-label">Additional scope to append (numbering continues from this plan's tasks)</label>
            <textarea v-model="extendDescription" rows="3" class="plan-extend-input"
              placeholder="e.g. also add rate limiting to the login endpoint" />
            <div class="plan-extend-actions">
              <label class="plan-extend-deep">
                <input type="checkbox" v-model="extendDeep" /> Deep analysis (discovery + risks for the added scope)
              </label>
              <Button severity="secondary" @click="showExtendForm = false">Cancel</Button>
              <Button :disabled="!extendDescription.trim() || generating" @click="extendPlan">
                <i class="pi pi-sparkles" /> Generate Extension
              </Button>
            </div>
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

  <!-- Clarifying questions from the planning agent (feature: plan ask) -->
  <Dialog v-model:visible="showQuestionForm" modal header="A few questions before planning"
          :style="{width:'560px'}" :draggable="false" :closable="false">
    <div v-if="pendingQuestions" class="qa-body">
      <p v-if="pendingQuestions.goal_analysis" class="qa-goal">
        <strong>Goal:</strong> {{ pendingQuestions.goal_analysis }}
      </p>
      <div v-for="(q, qi) in pendingQuestions.questions" :key="q.id" class="qa-question">
        <div class="qa-q-title">{{ qi + 1 }}. {{ q.question }}</div>
        <div v-if="q.rationale" class="qa-q-why">Why: {{ q.rationale }}</div>

        <template v-if="q.type === 'single_choice'">
          <label v-for="o in q.options" :key="o.value" class="qa-opt">
            <input type="radio" :name="'q-'+q.id" :value="o.value" v-model="answerDraft[q.id].choice" />
            <span class="qa-opt-label">{{ o.label }}</span>
            <span v-if="o.rationale" class="qa-opt-why">— {{ o.rationale }}</span>
          </label>
          <label v-if="q.allow_freetext" class="qa-opt">
            <input type="radio" :name="'q-'+q.id" value="__freetext__" v-model="answerDraft[q.id].choice" />
            <span class="qa-opt-label">✎ Type my own</span>
          </label>
          <input v-if="answerDraft[q.id].choice === '__freetext__'" v-model="answerDraft[q.id].freetext"
                 class="qa-input" placeholder="Your answer" />
        </template>

        <template v-else-if="q.type === 'multi_choice'">
          <label v-for="o in q.options" :key="o.value" class="qa-opt">
            <input type="checkbox" :value="o.value" v-model="answerDraft[q.id].choices" />
            <span class="qa-opt-label">{{ o.label }}</span>
            <span v-if="o.rationale" class="qa-opt-why">— {{ o.rationale }}</span>
          </label>
          <label v-if="q.allow_freetext" class="qa-opt">
            <input type="checkbox" v-model="answerDraft[q.id].useFreetext" />
            <span class="qa-opt-label">✎ Add my own</span>
          </label>
          <input v-if="answerDraft[q.id].useFreetext" v-model="answerDraft[q.id].freetext"
                 class="qa-input" placeholder="Your answer" />
        </template>

        <template v-else>
          <textarea v-model="answerDraft[q.id].freetext" class="qa-textarea" rows="2"
                    :placeholder="q.rationale || 'Your answer'" />
        </template>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="cancelQuestions" />
      <Button label="Generate Plan" icon="pi pi-sparkles" :disabled="!canSubmitQuestionAnswers" @click="submitAnswers" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import Dialog from 'primevue/dialog';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useLogTerminal } from '../../composables/useLogTerminal.js';
import { useWsStore } from '../../stores/ws.js';
import { useProcessStore } from '../../stores/process.js';
import { useOrchestrationStore } from '../../stores/orchestration.js';
import { usePickupStore } from '../../stores/pickup.js';
import ProviderIcon from '../ProviderIcon.vue';
import PlanDiscuss from './PlanDiscuss.vue';

const route = useRoute();
const projectId = computed(() => route.params.id);
const ws = useWsStore();
const proc = useProcessStore();
const orch = useOrchestrationStore();
const pickup = usePickupStore();

// Issue pickup (feature #55): if an issue was picked up into this project, open
// the New-Plan form already filled with the issue title/body + source link.
function applyPickupPrefill() {
  const p = pickup.consumePrefill(projectId.value);
  if (!p) return;
  description.value = p.description;
  deep.value = false;
  genError.value = '';
  selectedPlan.value = null;
  showNewPlanForm.value = true;
}

// Plan list
const plans = ref([]);
const selectedPlan = ref(null);
const nowMs = ref(Date.now());
let relativeTimer = null;

// Form state
const description = ref('');
const deep = ref(false);
const showNewPlanForm = ref(false);
const uploadedFile = ref(null);
const fileInputRef = ref(null);

// File → object storage (S3). When configured, an "Upload" button uploads a file
// and inserts its shareable link into the description textbox.
const storageConfigured = ref(false);
const uploadInputRef = ref(null);
const uploading = ref(false);

// Base branch the worktree is cut from (fetched fresh from origin at run time)
const selectedBase = ref('');
const availableBranches = ref([]);

// UI design baseline/template (built-in packs + personal ~/.jonggrang/design/*).
// Picking one here selects it up front so the planner styles from it and never
// asks the "which starter?" question (passed as `plan --baseline <key>`).
const selectedBaseline = ref('');
const availableBaselines = ref([]);
const baselineOptions = computed(() => availableBaselines.value.map(b => ({
  value: b.key,
  label: b.source === 'design' ? `${b.key} · your design` : b.key,
})));

// Tool / model / effort
const selectedTool = ref(null);
const selectedModel = ref(null);
const selectedEffort = ref(null);
const showToolModal = ref(false);
const availableModels = ref([]);
const availableEfforts = ref([]);
const loadingModels = ref(false);

// Plan clarifying questions (feature: plan ask). When the planning agent submits
// questions, the server relays them via the `plan.questions` socket event; we show
// a form, collect answers, and POST them to run Pass B (plan generation).
const pendingQuestions = ref(null);   // { goal_analysis, questions:[] } or null
const showQuestionForm = ref(false);
const answerDraft = reactive({});     // keyed by question id
const canSubmitQuestionAnswers = computed(() => {
  const question = pendingQuestions.value?.questions?.find(item => item.id === 'ui-preference');
  if (!question) return true;
  const draft = answerDraft[question.id] || {};
  if (!draft.choice) return false;
  return draft.choice !== '__freetext__' || Boolean((draft.freetext || '').trim());
});

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
// Refresh-only: a Pass A run already produced clarifying questions and is waiting
// for answers. There's no live process to show a spinner for, so this flag renders
// a "questions ready" continuation of the (now-finished) generating context — the
// QA dialog then reads as a follow-on, never a bare dialog appearing from nowhere.
const questionsReady = ref(false);
const genLog = ref('');
const genError = ref('');

// Restore the active-op spinner from server truth (the process store, hydrated
// from the subscribe snapshot). Lets a generate/revise/extend/approve op survive
// a browser refresh instead of silently dropping the spinner + log region.
// Maps the server command kind → the matching local flag.
function restorePlanProcessState(info) {
  const command = info?.command;
  // Both directions. This only ever set flags, so when the store went back to
  // idle the watcher fired with null and cleared nothing — a spinner restored
  // from a snapshot stayed on screen for the rest of the session.
  generating.value = command === 'plan' || command === 'plan-extend';
  revising.value = command === 'plan-revise';
  approving.value = command === 'approve';
}

// Populate the QA form state from a questions payload (goal + question list).
// Shared by the live `plan.questions` socket event and the refresh restore path
// so both build answerDraft identically.
function applyPlanQuestions(goal_analysis, questions) {
  Object.keys(answerDraft).forEach(k => delete answerDraft[k]);
  for (const q of (questions || [])) {
    if (q.type === 'multi_choice') answerDraft[q.id] = { choices: [], freetext: '', useFreetext: false };
    else if (q.type === 'single_choice') answerDraft[q.id] = {
      // ui-preference (baseline consent) must not auto-select a pack;
      // the user has to explicitly choose before submit is enabled.
      choice: q.id === 'ui-preference' ? '' : (q.options && q.options[0] ? q.options[0].value : ''),
      freetext: '',
    };
    else answerDraft[q.id] = { freetext: '' };
  }
  pendingQuestions.value = { goal_analysis: goal_analysis || '', questions: questions || [] };
  showQuestionForm.value = true;
}

// Refresh path: the subscribe snapshot flags that a Pass A run left unanswered
// clarifying questions. Fetch them and surface the QA dialog — but only as a
// continuation of a visible "questions ready" context (established here before
// the dialog), so it never appears cold. If a plan op is still running with no
// questions yet, this no-ops and restorePlanProcessState shows the spinner alone.
async function restorePlanQuestions() {
  const pq = ws.planQuestions;
  if (!pq || pq.projectId !== projectId.value || !pq.pending) return;
  // Don't fight the live Pass A→questions flow or an already-open form.
  if (showQuestionForm.value || pendingQuestions.value) return;
  try {
    const url = pq.sessionId
      ? `/api/projects/${projectId.value}/plan/questions?session=${encodeURIComponent(pq.sessionId)}`
      : `/api/projects/${projectId.value}/plan/questions`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.exists || !Array.isArray(data.questions) || !data.questions.length) return;
    // Establish the generating→questions-ready continuation BEFORE the dialog.
    questionsReady.value = true;
    applyPlanQuestions(data.goal_analysis, data.questions);
  } catch { /* leave the user on the idle/plan view rather than a bare dialog */ }
}

// Extend-an-existing-plan (append) state
const showExtendForm = ref(false);
const extendDescription = ref('');
const extendDeep = ref(false);

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

// Discuss panel (interactive PTY session to the selected agent)
const showDiscussPanel = ref(false);
const discussTool = computed(() => selectedTool.value || 'jonggrang');

// Rendered markdown for viewer. Plans and UI artifacts may contain agent-authored
// raw HTML, so sanitize every markdown surface before passing it to v-html.
function renderMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(content || ''));
}

const renderedContent = computed(() => {
  const plan = selectedPlan.value;
  if (!plan) return '';
  return renderMarkdown(plan.content);
});

const renderedDraftContent = computed(() => renderMarkdown(planContent.value));
const renderedUiHandoff = computed(() => renderMarkdown(selectedPlan.value?.ui?.handoff_content));
const renderedUiGuide = computed(() => renderMarkdown(selectedPlan.value?.ui?.guide_content));
const renderedUiCurrentGuide = computed(() => renderMarkdown(selectedPlan.value?.ui?.current_guide_content));

// Computed
const isIdle = computed(() =>
  plans.value.length === 0 && !generating.value && !questionsReady.value && !showNewPlanForm.value
);

const canAddNewPlan = computed(() => true);

// Run badge per plan: live orchestration store first, API snapshot as fallback.
// Only surface states the plan status badge doesn't already cover.
function runBadgeOf(plan) {
  if (plan.status === 'draft') return null;
  const s = orch.groups[plan.id]?.status || plan.run_status;
  if (s === 'running' || s === 'queued') return 'live';
  if (s === 'failed' && plan.status !== 'failed') return 'failed';
  return null;
}

function relativeTime(ms) {
  const delta = Math.max(0, nowMs.value - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const month = Math.floor(day / 30);
  return `${month} mo ago`;
}

// Base branch push (plans/tasks state → main)
const base = reactive({ branch: 'main', has_remote: false, dirty: false });
const pushingBase = ref(false);
const baseNotice = ref('');
const baseError = ref('');

async function loadBase() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/base`);
    if (res.ok) Object.assign(base, await res.json());
  } catch {}
}

// Candidate base branches for the New Plan picker. Defaults the selection to the
// repo's resolved base (main/master). The worktree fetches this branch fresh
// from origin at run time, so the picker list only needs branch names.
async function loadBranches() {
  try {
    const res = await fetch(`/api/projects/${projectId.value}/branches`);
    if (!res.ok) return;
    const data = await res.json();
    availableBranches.value = data.branches || [];
    if (!selectedBase.value) selectedBase.value = data.default || availableBranches.value[0] || '';
  } catch {}
}

// Selectable UI baselines (built-in packs + personal design templates) for the
// New Plan "Design" picker. Empty list simply hides the picker.
async function loadBaselines() {
  try {
    const res = await fetch('/api/baselines');
    if (!res.ok) return;
    const data = await res.json();
    availableBaselines.value = data.baselines || [];
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
    planMtime.value = plan.mtime || null;
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

function toggleExtendForm() {
  showExtendForm.value = !showExtendForm.value;
  if (showExtendForm.value) { extendDescription.value = ''; extendDeep.value = false; }
}

// Extend the selected (approved/done) plan: generate an extension draft, which
// the user then approves — the appended tasks continue this plan's numbering.
async function extendPlan() {
  if (!extendDescription.value.trim() || generating.value || !selectedPlan.value) return;
  const featureId = selectedPlan.value.feature_id || selectedPlan.value.id;
  genError.value = '';
  genLog.value = '';
  generating.value = true;
  showExtendForm.value = false;
  try {
    const body = { description: extendDescription.value, deep: extendDeep.value };
    if (selectedTool.value)   body.tool   = selectedTool.value;
    if (selectedModel.value)  body.model  = selectedModel.value;
    if (selectedEffort.value) body.effort = selectedEffort.value;
    const res = await fetch(`/api/projects/${projectId.value}/plans/${featureId}/extend`, {
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

function triggerFileInput() {
  fileInputRef.value?.click();
}

function onFileChange(e) {
  const file = e.target.files?.[0];
  if (file) uploadedFile.value = file;
  e.target.value = '';
}

function clearFile() {
  uploadedFile.value = null;
}

async function loadStorageConfig() {
  try { const r = await fetch('/api/storage/config'); if (r.ok) storageConfigured.value = !!(await r.json()).configured; } catch {}
}
function triggerUpload() { uploadInputRef.value?.click(); }
async function onUploadChange(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || uploading.value) return;
  uploading.value = true; genError.value = '';
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch(`/api/storage/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: buf,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    // Drop the shareable link straight into the description textbox.
    description.value = description.value ? `${description.value.replace(/\s+$/, '')}\n${d.url}` : d.url;
  } catch (err) { genError.value = `Upload failed: ${err.message}`; }
  finally { uploading.value = false; }
}

async function generatePlan() {
  if ((!description.value.trim() && !uploadedFile.value) || generating.value) return;
  genError.value = '';
  genLog.value = '';
  generating.value = true;
  showNewPlanForm.value = false;
  pendingQuestions.value = null;
  showQuestionForm.value = false;
  try {
    const body = { description: description.value, deep: deep.value };
    if (selectedTool.value)   body.tool   = selectedTool.value;
    if (selectedModel.value)  body.model  = selectedModel.value;
    if (selectedEffort.value) body.effort = selectedEffort.value;
    if (selectedBase.value)   body.base   = selectedBase.value;
    if (selectedBaseline.value) body.baseline = selectedBaseline.value;

    if (uploadedFile.value) {
      // Read file as base64 in chunks to avoid blowing the call stack on
      // large files (spreading into String.fromCharCode can stack-overflow).
      const arrayBuffer = await uploadedFile.value.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const CHUNK = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      body.fileContent = btoa(binary);
      body.fileName = uploadedFile.value.name;
    }


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

// Build the answers payload from the form draft and run Pass B (plan generation).
async function submitAnswers() {
  if (!pendingQuestions.value) return;
  const FREETEXT = '__freetext__';
  const answers = [];
  for (const q of pendingQuestions.value.questions) {
    const d = answerDraft[q.id] || {};
    if (q.type === 'single_choice') {
      if (d.choice === FREETEXT) {
        answers.push({ id: q.id, question: q.question, type: q.type, value: FREETEXT, freetext: (d.freetext || '').trim() });
      } else {
        const opt = (q.options || []).find(o => o.value === d.choice);
        answers.push({ id: q.id, question: q.question, type: q.type, value: d.choice, label: opt ? opt.label : d.choice, freetext: null });
      }
    } else if (q.type === 'multi_choice') {
      const chosen = Array.isArray(d.choices) ? d.choices : [];
      const labels = chosen.map(v => { const o = (q.options || []).find(x => x.value === v); return o ? o.label : v; });
      answers.push({ id: q.id, question: q.question, type: q.type, value: chosen, label: labels.join(', '), freetext: d.useFreetext ? (d.freetext || '').trim() : null });
    } else {
      const t = (d.freetext || '').trim();
      answers.push({ id: q.id, question: q.question, type: 'text', value: t, freetext: t });
    }
  }

  genError.value = '';
  genLog.value = '';
  generating.value = true;
  questionsReady.value = false;
  showQuestionForm.value = false;
  const goal_analysis = pendingQuestions.value.goal_analysis || '';
  pendingQuestions.value = null;

  const body = { description: description.value, deep: deep.value, answers, goal_analysis };
  if (selectedTool.value)   body.tool   = selectedTool.value;
  if (selectedModel.value)  body.model  = selectedModel.value;
  if (selectedEffort.value) body.effort = selectedEffort.value;
  if (selectedBase.value)   body.base   = selectedBase.value;
  if (selectedBaseline.value) body.baseline = selectedBaseline.value;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/plan/answers`, {
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

function cancelQuestions() {
  showQuestionForm.value = false;
  pendingQuestions.value = null;
  generating.value = false;
  questionsReady.value = false;
  showNewPlanForm.value = true; // let the user edit the request and try again
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
      body: JSON.stringify({ instruction: reviseInstruction.value, sessionId: selectedPlan.value?.sessionId || selectedPlan.value?.id }),
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

async function savePlan() {
  if (!selectedPlan.value) return;
  const content = planContent.value;
  const res = await fetch(`/api/projects/${projectId.value}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, mtime: planMtime.value, sessionId: selectedPlan.value?.sessionId || selectedPlan.value?.id }),
  });
  if (res.ok) {
    const d = await res.json();
    planMtime.value = d.mtime;
    dirty.value = false;
  }
}

async function discardPlan() {
  if (!confirm('Discard this plan?')) return;
  const sessionId = encodeURIComponent(selectedPlan.value?.sessionId || selectedPlan.value?.id || '');
  await fetch(`/api/projects/${projectId.value}/plan?session=${sessionId}`, { method: 'DELETE' });
  selectedPlan.value = null;
  planContent.value = '';
  dirty.value = false;
  await loadPlans();
}

async function approvePlan() {
  if (dirty.value) await savePlan();
  genLog.value = '';
  approving.value = true;
  const res = await fetch(`/api/projects/${projectId.value}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: selectedPlan.value?.sessionId || selectedPlan.value?.id }),
  });
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
  relativeTimer = setInterval(() => { nowMs.value = Date.now(); }, 60_000);
  await loadPlans();
  await loadProjectTool();
  loadBase();
  loadBranches();
  loadBaselines();
  loadStorageConfig();
  applyPickupPrefill();

  // Restore the active plan-op spinner + log region from server truth. The
  // subscribe snapshot (via the process store) may land before or after this
  // mount, so react immediately to the current value and to later hydration.
  watch(() => proc.running, restorePlanProcessState, { immediate: true });

  // Restore the pending clarifying-questions dialog from server truth, sequenced
  // after a visible generating context. Like the spinner restore, the snapshot
  // may land before or after mount, so react immediately and to later hydration.
  watch(() => ws.planQuestions, restorePlanQuestions, { immediate: true });

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

  socket.on('plan.content', ({ project_id, sessionId, content, mtime }) => {
    if (project_id !== projectId.value) return;
    const selectedSession = selectedPlan.value?.sessionId || selectedPlan.value?.id;
    if (!selectedSession || selectedSession === sessionId) {
      planContent.value = content;
      planMtime.value = mtime;
    }
    // Reload plan list to reflect new draft sessions and status changes
    loadPlans();
  });

  socket.on('plan.deleted', ({ project_id, sessionId }) => {
    if (project_id !== projectId.value) return;
    const selectedSession = selectedPlan.value?.sessionId || selectedPlan.value?.id;
    if (!sessionId || selectedSession === sessionId) {
      planContent.value = '';
      planMtime.value = null;
      dirty.value = false;
    }
    loadPlans();
  });

  socket.on('plan.questions', ({ project_id, goal_analysis, questions }) => {
    if (project_id !== projectId.value) return;
    applyPlanQuestions(goal_analysis, questions);
    // Live flow: the generating spinner the user already sees hands off to the
    // dialog. (questionsReady is a refresh-only fallback, so leave it untouched.)
    generating.value = false;
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
    // When the agent surfaced questions (Pass A), keep the description and the
    // question form — generation isn't done; we're waiting for the user's answers.
    if (pendingQuestions.value) return;
    if (wasGenerating || wasRevising || wasApproving) {
      description.value = '';
      uploadedFile.value = null;
      if (wasGenerating) selectedPlan.value = null; // select the newly-created newest draft
      loadPlans();
    }
  });
});

watch(projectId, loadPlans);

onUnmounted(() => {
  if (relativeTimer) clearInterval(relativeTimer);
});
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
.plan-form { width: 100%; max-width: 640px; margin-top: 12px; }
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
.plan-list-items { flex: 1; overflow-y: auto; padding: 4px; }

/* Extend-this-plan (append) form */
.plan-extend-form { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--jg-border); }
.plan-extend-label { font-size: 12px; color: var(--jg-text-dim); }
.plan-extend-input {
  width: 100%; padding: 6px 8px; border-radius: 6px;
  background: var(--jg-bg); border: 1px solid var(--jg-border); color: var(--jg-text);
  font-family: var(--font-mono); font-size: 12px;
}
.plan-extend-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
.plan-extend-deep { display: flex; align-items: center; gap: 6px; margin-right: auto; font-size: 12px; color: var(--jg-text-dim); cursor: pointer; }

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
.plan-age { font-size: 9px; color: var(--jg-text-faint); }
.plan-badge--run-live { background: color-mix(in oklch, var(--jg-green) 20%, transparent); color: var(--jg-green); animation: livePulse 1.2s infinite; }
.plan-badge--run-failed { background: color-mix(in oklch, var(--jg-red) 15%, transparent); color: var(--jg-red); }
.src-issue-link { display: inline-flex; align-items: center; gap: 2px; font-size: 9px; color: var(--jg-text-faint); text-decoration: none; }
.src-issue-link:hover { color: var(--jg-cyan); }
.src-issue-link .pi { font-size: 9px; }
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
.plan-new-inner { width: 100%; max-width: 640px; display: flex; flex-direction: column; gap: 12px; }
.plan-new-title { font-size: 13px; font-weight: 600; color: var(--jg-text); }
.plan-form-footer { display: flex; flex-wrap: wrap; justify-content: flex-start; align-items: center; gap: 10px 12px; margin-top: 8px; }
.plan-new-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
/* Footer splits into a config group (left) and an actions group (pinned right via
   margin-left:auto). flex-wrap lets the actions drop to their own right-aligned row
   on narrow widths instead of crushing the controls. */
.plan-footer-config { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.plan-footer-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }

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

/* UI guide + handoff review */
.ui-context-review { max-height: 46%; overflow-y: auto; border-top: 1px solid var(--jg-border); background: var(--jg-card); flex-shrink: 0; }
.ui-context-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--jg-border); background: var(--jg-card); }
.ui-context-title { font-size: 12px; font-weight: 700; color: var(--jg-text); }
.ui-context-path { margin-top: 2px; font-size: 10px; color: var(--jg-text-faint); }
.ui-context-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.ui-context-badge { padding: 2px 6px; border: 1px solid var(--jg-border); color: var(--jg-cyan); font-size: 10px; }
.ui-context-details { border-bottom: 1px solid var(--jg-border); }
.ui-context-details summary { cursor: pointer; padding: 8px 16px; color: var(--jg-text-dim); font-size: 11px; font-weight: 600; }
.ui-context-details summary:hover { color: var(--jg-text); background: var(--jg-hover); }
.ui-guide-compare { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); border-top: 1px solid var(--jg-border); }
.ui-guide-compare--single { grid-template-columns: minmax(0, 1fr); }
.ui-guide-version { min-width: 0; padding: 0 14px 14px; overflow-x: auto; }
.ui-guide-version + .ui-guide-version { border-left: 1px solid var(--jg-border); }
.ui-guide-version-label { position: sticky; top: 0; padding: 8px 0 6px; background: var(--jg-card); color: var(--jg-text-faint); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
.ui-context-markdown { padding: 0 16px 12px; color: var(--jg-text-dim); font-size: 11px; line-height: 1.6; }
.ui-guide-version .ui-context-markdown { padding: 0; }
.ui-context-markdown :deep(h1), .ui-context-markdown :deep(h2), .ui-context-markdown :deep(h3) { margin: 12px 0 6px; color: var(--jg-text); font-size: 12px; }
.ui-context-markdown :deep(p), .ui-context-markdown :deep(ul) { margin: 0 0 8px; }
.ui-context-markdown :deep(pre) { overflow-x: auto; padding: 8px; border: 1px solid var(--jg-border); background: var(--jg-bg); }
.ui-context-markdown :deep(code) { font-family: var(--font-mono); font-size: 10px; }

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

/* File badge */
.file-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; margin-bottom: 8px;
  background: color-mix(in oklch, var(--jg-cyan) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--jg-cyan) 30%, transparent);
  font-family: var(--font-mono); font-size: 11px; color: var(--jg-cyan);
}
.file-badge .pi-file { font-size: 11px; }
.file-badge span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
.file-badge-clear {
  background: none; border: none; color: var(--jg-text-faint);
  cursor: pointer; padding: 0; display: flex; align-items: center;
}
.file-badge-clear:hover { color: var(--jg-red); }
.file-badge-clear .pi { font-size: 10px; }

/* Shared */
.deep-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--jg-text-faint); white-space: nowrap; }
.base-select { min-width: 144px; font-size: 12px; }
/* Keep the primary action on one line — never let "Generate Plan" wrap. */
.plan-generate-btn { white-space: nowrap; flex-shrink: 0; }
.plan-generate-btn :deep(.p-button-label) { white-space: nowrap; }
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

/* Clarifying questions form (feature: plan ask) */
.qa-body { display: flex; flex-direction: column; gap: 16px; max-height: 60vh; overflow-y: auto; }
.qa-goal { margin: 0; font-size: 13px; color: var(--jg-text-dim); }
.qa-question { display: flex; flex-direction: column; gap: 4px; }
.qa-q-title { font-weight: 600; font-size: 13px; color: var(--jg-text); }
.qa-q-why { font-size: 12px; color: var(--jg-text-dim); margin-bottom: 4px; }
.qa-opt { display: flex; align-items: baseline; gap: 6px; font-size: 13px; cursor: pointer; padding: 2px 0; }
.qa-opt-label { color: var(--jg-text); }
.qa-opt-why { color: var(--jg-text-dim); font-size: 12px; }
.qa-input, .qa-textarea {
  width: 100%; padding: 6px 8px; border-radius: 6px; margin-top: 4px;
  background: var(--jg-bg); border: 1px solid var(--jg-border);
  color: var(--jg-text); font-family: var(--font-mono); font-size: 12px; outline: none;
}
.qa-input:focus, .qa-textarea:focus { border-color: var(--jg-green); }
</style>
