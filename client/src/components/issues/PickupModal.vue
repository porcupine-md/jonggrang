<template>
  <Dialog :visible="visible" modal header="Pickup → Plan" :style="{ width: '420px' }" :draggable="false"
          @update:visible="$emit('close')">
    <div class="pickup-body">
      <div class="pickup-source">
        <span class="prov-badge" :class="`prov-badge--${source.provider}`">
          <i :class="source.provider === 'github' ? 'pi pi-github' : 'pi pi-gitlab'" />
          {{ source.repo }}#{{ source.number }}
        </span>
        <div class="pickup-title">{{ source.title }}</div>
      </div>

      <div class="pickup-choice">
        <label class="choice-row">
          <input type="radio" value="existing" v-model="target" />
          <span>Existing project</span>
        </label>
        <Select
          v-if="target === 'existing'"
          v-model="selectedProject"
          :options="projectOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select a project"
          filter
          class="pickup-select"
        />
        <label class="choice-row">
          <input type="radio" value="new" v-model="target" />
          <span>New project (launch wizard)</span>
        </label>
      </div>

      <div v-if="error" class="error-text">{{ error }}</div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" @click="$emit('close')" />
      <Button :disabled="busy || (target === 'existing' && !selectedProject)" @click="confirm">
        <i v-if="busy" class="pi pi-spin pi-spinner" />
        {{ busy ? 'Picking up…' : 'Pickup' }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useProjectsStore } from '../../stores/projects.js';
import { useIssuesStore } from '../../stores/issues.js';
import { usePickupStore } from '../../stores/pickup.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  source: { type: Object, required: true }, // { provider, repo, number, title }
});
const emit = defineEmits(['close']);

const router = useRouter();
const projects = useProjectsStore();
const issues = useIssuesStore();
const pickup = usePickupStore();

const target = ref('existing');
const selectedProject = ref(null);
const busy = ref(false);
const error = ref('');

const projectOptions = computed(() =>
  projects.list
    .filter(p => p.init_status === 'ready' || p.init_status === 'imported')
    .map(p => ({ label: p.name, value: p.id })));

onMounted(() => {
  if (!projects.list.length) projects.fetchAll();
  if (!projectOptions.value.length) target.value = 'new';
});

async function confirm() {
  error.value = '';
  busy.value = true;
  try {
    if (target.value === 'new') {
      // Park the intent; ImportFlowView finalizes the pickup post-import.
      pickup.setPending({ ...props.source });
      emit('close');
      router.push('/import');
      return;
    }
    const projectId = selectedProject.value;
    const res = await issues.pickup(props.source.provider, props.source.repo, props.source.number, projectId);
    pickup.setPrefill({ projectId, description: res.description, source: res.source });
    emit('close');
    router.push(`/projects/${projectId}/plan`);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.pickup-body { display: flex; flex-direction: column; gap: 14px; }
.pickup-source { background: var(--jg-bg); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 10px 12px; }
.prov-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-family: var(--font-mono); color: var(--jg-text-muted); }
.prov-badge--gitlab { color: var(--jg-orange, #fc6d26); }
.pickup-title { font-size: 13px; color: var(--jg-text); margin-top: 6px; line-height: 1.4; }
.pickup-choice { display: flex; flex-direction: column; gap: 10px; }
.choice-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--jg-text); cursor: pointer; }
.choice-row input { accent-color: var(--jg-green); }
.pickup-select { width: 100%; margin: -2px 0 4px 22px; }
.error-text { font-size: 11px; color: var(--jg-red); }
</style>
