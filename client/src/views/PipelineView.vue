<template>
  <div class="pipeline-view">
    <div class="pipeline-header">
      <span class="pipeline-title"><i class="pi pi-sitemap" /> Pipeline</span>
      <span v-if="manifest.data" class="pipeline-progress">{{ doneCount }}/{{ activeCount }} phases</span>
    </div>
    <div class="pipeline-body">
      <PhaseTimeline />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useManifestStore } from '../stores/manifest.js';
import PhaseTimeline from '../components/pipeline/PhaseTimeline.vue';

const route = useRoute();
const projectId = computed(() => route.params.id);
const manifest = useManifestStore();

const doneCount = computed(() => manifest.phases.filter(p => p.status === 'completed').length);
const activeCount = computed(() => manifest.phases.filter(p => p.status !== 'skipped').length);

onMounted(() => manifest.fetch(projectId.value));
watch(projectId, id => { if (id) manifest.fetch(id); });
</script>

<style scoped>
.pipeline-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.pipeline-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0;
}
.pipeline-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.07em; color: var(--jg-text-faint);
  display: flex; align-items: center; gap: 6px;
}
.pipeline-progress { font-size: 11px; color: var(--jg-text-faint); }

.pipeline-body { flex: 1; overflow: hidden; }
</style>
