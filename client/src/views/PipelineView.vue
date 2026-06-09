<template>
  <div class="pipeline-view">
    <div class="pipeline-header">
      <span class="pipeline-title"><i class="pi pi-sitemap" /> Pipeline</span>
      <div class="pipeline-head-right">
        <span v-if="manifest.data" class="pipeline-progress">{{ doneCount }}/{{ activeCount }} phases</span>
        <button
          v-if="featureId && !pipelineComplete"
          class="phase-run-btn"
          :disabled="running"
          :title="'Run remaining phases (Simplify → … → Completion) via jonggrang work --resume'"
          @click="runPhase"
        >
          <i :class="running ? 'pi pi-spin pi-spinner' : 'pi pi-play'" /> Run Phase
        </button>
      </div>
    </div>
    <p v-if="phaseError" class="pipeline-error">{{ phaseError }}</p>
    <div class="pipeline-body">
      <PhaseTimeline />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useManifestStore } from '../stores/manifest.js';
import PhaseTimeline from '../components/pipeline/PhaseTimeline.vue';

const route = useRoute();
const projectId = computed(() => route.params.id);
const featureId = computed(() => route.params.featureId || null);
const manifest = useManifestStore();

const doneCount = computed(() => manifest.phases.filter(p => p.status === 'completed').length);
const activeCount = computed(() => manifest.phases.filter(p => p.status !== 'skipped').length);
const pipelineComplete = computed(() => activeCount.value > 0 && doneCount.value >= activeCount.value);

const running = ref(false);
const phaseError = ref('');

// Continue the pipeline from where it stopped — runs `jonggrang work --resume`
// in the plan's worktree (Simplify and the remaining review/test phases that
// the per-task worktree runs skip).
async function runPhase() {
  if (!featureId.value) return;
  running.value = true; phaseError.value = '';
  try {
    const res = await fetch(`/api/projects/${projectId.value}/orchestration/groups/${featureId.value}/resume`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      phaseError.value = d.error?.message || `Failed (${res.status})`;
    }
  } catch (e) {
    phaseError.value = e.message;
  }
  running.value = false;
}

onMounted(() => manifest.fetch(projectId.value, featureId.value));
watch([projectId, featureId], ([id, fid]) => { if (id) manifest.fetch(id, fid); });
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
.pipeline-head-right { display: flex; align-items: center; gap: 12px; }
.pipeline-progress { font-size: 11px; color: var(--jg-text-faint); }
.phase-run-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
  background: var(--jg-green); color: #000; border: 1px solid var(--jg-green);
  border-radius: var(--radius); transition: opacity 0.15s;
}
.phase-run-btn:hover:not(:disabled) { opacity: 0.85; }
.phase-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.phase-run-btn .pi { font-size: 10px; }
.pipeline-error { color: var(--jg-red); font-size: 11px; margin: 6px 16px 0; }

.pipeline-body { flex: 1; overflow: hidden; }
</style>
