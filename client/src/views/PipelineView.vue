<template>
  <div class="pipeline-view">
    <Tabs v-model:value="tab" class="pv-tabs">
      <TabList>
        <Tab value="plan">
          Plan
          <Tag v-if="planState" :value="planStateLabel" size="small" :severity="planStateSeverity" style="margin-left:6px" />
        </Tab>
        <Tab value="phases">
          Phases
          <Badge v-if="manifest.data" :value="`${doneCount}/${activeCount}`" style="margin-left:6px" />
        </Tab>
      </TabList>
      <TabPanels>
        <!-- Plan tab -->
        <TabPanel value="plan" class="pv-body">
          <div v-if="loading" class="pv-empty">Loading plan...</div>
          <div v-else-if="!planContent" class="pv-empty">
            No plan found for this project.
          </div>
          <!-- read-only view for archived plans -->
          <div v-else class="plan-readonly">
            <div class="plan-readonly-bar">
              <Tag v-if="planMeta?.work_type" :value="planMeta.work_type" :severity="workTypeSeverity" size="small" />
              <span class="readonly-label">{{ planStateLabel }} · Read only</span>
            </div>
            <div class="plan-preview" v-html="renderedPlan"></div>
          </div>
        </TabPanel>

        <!-- Phases tab -->
        <TabPanel value="phases" class="pv-body pv-body--phases">
          <PhaseTimeline />
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Tag from 'primevue/tag';
import Badge from 'primevue/badge';
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

const planStateSeverity = computed(() => ({
  draft: 'warn',
  archived: 'info',
  archived_done: 'success',
}[planState.value] || 'secondary'));

const workTypeSeverity = computed(() => {
  const wt = (planMeta.value?.work_type || '').toLowerCase();
  return { bugfix: 'danger', small: 'info', medium: 'success', large: 'warn' }[wt] || 'secondary';
});

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

  const socket = ws.socket;
  if (socket) {
    socket.on('plan.content', ({ project_id, content }) => {
      if (project_id !== projectId.value) return;
      planContent.value = content;
      planState.value = 'draft';
    });
    socket.on('plan.deleted', ({ project_id }) => {
      if (project_id !== projectId.value) return;
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

.pv-tabs { display: flex; flex-direction: column; height: 100%; }
.pv-tabs :deep(.p-tabpanels) { flex: 1; overflow: hidden; padding: 0; }
.pv-tabs :deep(.p-tabpanel) { height: 100%; }

.pv-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; height: 100%; }
.pv-body--phases { overflow: hidden; }

.pv-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--jg-text-faint);
}

.plan-readonly { display: flex; flex-direction: column; flex: 1; overflow: hidden; padding: 16px; gap: 12px; }
.plan-readonly-bar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.readonly-label { font-size: 11px; color: var(--jg-text-faint); }

.plan-preview {
  flex: 1; overflow-y: auto;
  background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius);
  padding: 16px; font-size: 13px; color: var(--jg-text); line-height: 1.6;
}
.plan-preview :deep(h1), .plan-preview :deep(h2), .plan-preview :deep(h3) { color: var(--jg-text); margin: 12px 0 6px; }
.plan-preview :deep(p) { margin-bottom: 8px; }
.plan-preview :deep(ul), .plan-preview :deep(ol) { padding-left: 20px; margin-bottom: 8px; }
.plan-preview :deep(code) { background: var(--jg-hover); padding: 2px 4px; border-radius: 0px; color: var(--jg-green); }
.plan-preview :deep(pre) { background: var(--jg-card); padding: 10px; border-radius: var(--radius); overflow-x: auto; margin-bottom: 8px; }
</style>
