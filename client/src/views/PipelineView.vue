<template>
  <div class="pipeline-view">
    <div class="pv-tabs">
      <button class="pv-tab" :class="{ 'pv-tab--active': tab === 'plan' }" @click="tab = 'plan'">
        Plan
        <span v-if="planState" class="plan-state-chip" :class="`psc--${planState}`">
          {{ planStateLabel }}
        </span>
      </button>
      <button class="pv-tab" :class="{ 'pv-tab--active': tab === 'phases' }" @click="tab = 'phases'">
        Phases
        <span v-if="manifest.data" class="phase-progress-chip">
          {{ doneCount }}/{{ activeCount }}
        </span>
      </button>
    </div>

    <!-- Plan tab -->
    <div v-if="tab === 'plan'" class="pv-body">
      <div v-if="loading" class="pv-empty">Loading plan...</div>
      <div v-else-if="!planContent" class="pv-empty">
        No plan found for this project.
      </div>
      <!-- read-only view for archived plans -->
      <div v-else class="plan-readonly">
        <div class="plan-readonly-bar">
          <span v-if="planMeta?.work_type" class="work-type-badge" :class="`wt--${planMeta.work_type.toLowerCase()}`">
            {{ planMeta.work_type }}
          </span>
          <span class="readonly-label">{{ planStateLabel }} · Read only</span>
        </div>
        <div class="plan-preview" v-html="renderedPlan"></div>
      </div>
    </div>

    <!-- Phases tab -->
    <div v-if="tab === 'phases'" class="pv-body pv-body--phases">
      <PhaseTimeline />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import { useManifestStore } from '../stores/manifest.js';
import { useWsStore } from '../stores/ws.js';
import PhaseTimeline from '../components/pipeline/PhaseTimeline.vue';

const route = useRoute();
const projectId = computed(() => route.params.id);
const manifest = useManifestStore();
const ws = useWsStore();

const tab = ref('plan');
const planContent = ref('');
const planMeta = ref(null);
const planState = ref(null);
const loading = ref(false);

const renderedPlan = computed(() => {
  try { return marked.parse(planContent.value || ''); } catch { return planContent.value; }
});

const planStateLabel = computed(() => ({
  draft: 'Draft',
  archived: 'In Progress',
  archived_done: 'Done',
}[planState.value] || ''));

const doneCount = computed(() =>
  manifest.phases.filter(p => p.status === 'completed').length
);
const activeCount = computed(() =>
  manifest.phases.filter(p => p.status !== 'skipped').length
);

async function loadPlan() {
  loading.value = true;
  try {
    const res = await fetch(`/api/projects/${projectId.value}/plan`);
    if (!res.ok) { planContent.value = ''; return; }
    const data = await res.json();
    if (data.exists) {
      planContent.value = data.content;
      planState.value = data.state;
      planMeta.value = { work_type: data.work_type, feature_id: data.feature_id };
    } else {
      planContent.value = '';
      planState.value = null;
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    loadPlan(),
    manifest.fetch(projectId.value),
  ]);

  // Update plan content live if it's still a draft
  const socket = ws.socket;
  if (socket) {
    socket.on('plan.content', ({ project_id, content }) => {
      if (project_id !== projectId.value) return;
      planContent.value = content;
      planState.value = 'draft';
    });
    socket.on('plan.deleted', ({ project_id }) => {
      if (project_id !== projectId.value) return;
      // Plan was archived — reload to get archived version
      loadPlan();
    });
  }
});

watch(projectId, async (id) => {
  if (!id) return;
  planContent.value = '';
  await Promise.all([loadPlan(), manifest.fetch(id)]);
});
</script>

<style scoped>
.pipeline-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.pv-tabs {
  display: flex; gap: 2px; padding: 8px 16px 0;
  border-bottom: 1px solid #1e1f2a; flex-shrink: 0;
}
.pv-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 14px; border: none; background: none; cursor: pointer;
  font-size: 13px; color: #6b7280; border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.pv-tab:hover { color: #9ca3af; }
.pv-tab--active { color: #a78bfa; border-bottom-color: #a78bfa; }

.plan-state-chip {
  font-size: 10px; padding: 1px 5px; border-radius: 8px; font-weight: 500;
}
.psc--draft          { background: #78350f; color: #fcd34d; }
.psc--archived       { background: #1e3a5f; color: #93c5fd; }
.psc--archived_done  { background: #065f46; color: #6ee7b7; }

.phase-progress-chip {
  font-size: 10px; background: #1e1f2a; color: #6b7280;
  padding: 1px 6px; border-radius: 8px;
}

.pv-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
.pv-body--phases { overflow: hidden; }

.pv-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: #4b5563;
}

.plan-readonly { display: flex; flex-direction: column; flex: 1; overflow: hidden; padding: 16px; gap: 12px; }
.plan-readonly-bar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.readonly-label { font-size: 11px; color: #4b5563; }

.work-type-badge {
  font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.wt--bugfix  { background: #7f1d1d; color: #fca5a5; }
.wt--small   { background: #1e3a5f; color: #93c5fd; }
.wt--medium  { background: #14532d; color: #86efac; }
.wt--large   { background: #312e81; color: #c4b5fd; }

.plan-preview {
  flex: 1; overflow-y: auto;
  background: #0a0b0f; border: 1px solid #2d2f3e; border-radius: 6px;
  padding: 16px; font-size: 13px; color: #d1d5db; line-height: 1.6;
}
.plan-preview :deep(h1), .plan-preview :deep(h2), .plan-preview :deep(h3) { color: #f4f4f5; margin: 12px 0 6px; }
.plan-preview :deep(p) { margin-bottom: 8px; }
.plan-preview :deep(ul), .plan-preview :deep(ol) { padding-left: 20px; margin-bottom: 8px; }
.plan-preview :deep(code) { background: #1e1f2a; padding: 2px 4px; border-radius: 3px; }
.plan-preview :deep(pre) { background: #1e1f2a; padding: 10px; border-radius: 6px; overflow-x: auto; margin-bottom: 8px; }
</style>
