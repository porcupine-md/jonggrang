<template>
  <div class="pipeline-view">
    <div class="pipeline-header">
      <span class="pipeline-title"><i class="pi pi-sitemap" /> Pipeline</span>
      <div class="pipeline-head-right">
        <span v-if="manifest.data" class="pipeline-progress">{{ doneCount }}/{{ activeCount }} phases</span>
        <span v-if="deferredCount" class="pipeline-deferred" :title="'Compact mode stopped after Implement — ' + deferredCount + ' quality gate phase(s) deferred'">
          <i class="pi pi-clock" /> {{ deferredCount }} deferred
        </span>
        <button
          v-if="featureId && (!pipelineComplete || deferredCount)"
          class="phase-run-btn"
          :class="{ 'phase-run-btn--failed': isFailed }"
          :disabled="running"
          :title="runTitle"
          @click="runPhase"
        >
          <i :class="running ? 'pi pi-spin pi-spinner' : (isFailed ? 'pi pi-refresh' : 'pi pi-play')" /> {{ runLabel }}
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
const isFailed = computed(() => manifest.data?.status === 'failed');
const deferredCount = computed(() => manifest.deferredPhases.length);

const runLabel = computed(() => {
  if (deferredCount.value) return 'Run quality gates';
  return isFailed.value ? 'Resume' : 'Run Phase';
});
const runTitle = computed(() => deferredCount.value
  ? 'Compact mode deferred these gates — run them now via jonggrang work --resume --full'
  : 'Run remaining phases (Simplify → … → Completion) via jonggrang work --resume');

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
.pipeline-deferred {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--jg-orange);
}
.pipeline-deferred .pi { font-size: 10px; }
.phase-run-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
  background: var(--jg-green); color: #000; border: 1px solid var(--jg-green);
  border-radius: var(--radius); transition: opacity 0.15s;
}
.phase-run-btn--failed { background: var(--jg-red); border-color: var(--jg-red); color: #fff; }
.phase-run-btn:hover:not(:disabled) { opacity: 0.85; }
.phase-run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.phase-run-btn .pi { font-size: 10px; }
.pipeline-error { color: var(--jg-red); font-size: 11px; margin: 6px 16px 0; }

.pipeline-body { flex: 1; overflow: hidden; }
</style>
