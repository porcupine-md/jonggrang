<script setup>
import { PHASES_UI, ROLE_COLORS, getWorkTypeStyle } from '../../utils/appUi';

defineProps({
  isRunning: {
    type: Boolean,
    default: false,
  },
  pipelineManifest: {
    type: Object,
    default: null,
  },
  loadingPhaseRows: {
    type: Array,
    default: () => [],
  },
  phaseRows: {
    type: Array,
    default: () => [],
  },
  qualityGates: {
    type: Array,
    default: () => [],
  },
});

defineEmits(['resume']);

function phaseIcon(phase) {
  if (!phase.active) return '–';
  if (phase.status === 'completed') return '✓';
  if (phase.status === 'running') return '⟳';
  if (phase.status === 'failed') return '✗';
  if (phase.status === 'skipped') return '–';
  return '·';
}

function phaseClass(phase) {
  if (!phase.active || phase.status === 'skipped') return 'ph-skip';
  return { completed: 'ph-done', running: 'ph-run', failed: 'ph-fail' }[phase.status] || 'ph-wait';
}
</script>

<template>
  <div v-if="isRunning && !pipelineManifest" class="pipeline-section pipeline-loading">
    <div class="pipeline-header">
      <div class="pipeline-title">
        <span class="pipeline-name">Planning...</span>
      </div>
      <div class="pipeline-status">
        <span class="ps-dot running"></span>
        <span class="ps-text">Running</span>
      </div>
    </div>
    <div class="phase-grid">
        <div v-for="row in loadingPhaseRows" :key="row[0]" class="phase-row">
          <div v-for="phaseNumber in row" :key="phaseNumber" class="phase-cell ph-wait">
            <span class="phase-icon">·</span>
            <span class="phase-num">{{ phaseNumber }}</span>
            <span class="phase-name">{{ PHASES_UI[phaseNumber].name }}</span>
            <span
              v-if="PHASES_UI[phaseNumber].role"
              class="phase-role"
              :style="{ color: ROLE_COLORS[PHASES_UI[phaseNumber].role] }"
            >
              {{ PHASES_UI[phaseNumber].role }}
            </span>
          </div>
        </div>
    </div>
  </div>

  <div v-if="pipelineManifest" class="pipeline-section">
    <div class="pipeline-header">
      <div class="pipeline-title">
        <span class="pipeline-name">{{ pipelineManifest.description || 'Pipeline' }}</span>
        <span class="wt-badge" :style="getWorkTypeStyle(pipelineManifest.work_type)">
          {{ pipelineManifest.work_type }}
        </span>
      </div>
      <div class="pipeline-status">
        <span :class="['ps-dot', pipelineManifest.status]"></span>
        <span class="ps-text">
          {{ pipelineManifest.status === 'failed' ? 'Failed' : pipelineManifest.status === 'completed' ? 'Complete' : `Phase ${pipelineManifest.current_phase}` }}
        </span>
        <button v-if="pipelineManifest.status === 'failed'" class="resume-btn" @click="$emit('resume')">↺ Resume</button>
      </div>
    </div>

    <div class="phase-grid">
      <div v-for="row in phaseRows" :key="row[0].n" class="phase-row">
        <div v-for="phase in row" :key="phase.n" :class="['phase-cell', phaseClass(phase)]" :title="`${phase.n}. ${phase.name}`">
          <span class="phase-icon">{{ phaseIcon(phase) }}</span>
          <span class="phase-num">{{ phase.n }}</span>
          <span class="phase-name">{{ phase.name }}</span>
          <span v-if="phase.role" class="phase-role" :style="{ color: ROLE_COLORS[phase.role] }">{{ phase.role }}</span>
        </div>
      </div>
    </div>

    <div class="gates-row">
      <span v-for="gate in qualityGates" :key="gate.label" :class="['gate', { ok: gate.ok }]">
        {{ gate.ok ? '✓' : '·' }} {{ gate.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.pipeline-section {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-subtle);
  padding: 10px;
}

.pipeline-header {
  margin-bottom: 8px;
}

.pipeline-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.pipeline-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.pipeline-status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.wt-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.ps-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.ps-dot.running,
.ps-dot.in_progress {
  background: var(--green);
  animation: blink 1s infinite;
}

.ps-dot.failed {
  background: var(--red);
}

.ps-dot.completed {
  background: var(--green);
}

.ps-text {
  font-size: 11px;
  color: var(--text-secondary);
}

.resume-btn {
  font-size: 11px;
  color: var(--yellow);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

.resume-btn:hover {
  text-decoration: underline;
}

.phase-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}

.phase-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
}

.phase-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 2px;
  border-radius: 4px;
  background: var(--bg-elevated);
  border: 1px solid transparent;
  min-width: 0;
  text-align: center;
}

.phase-cell.ph-done {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.2);
}

.phase-cell.ph-run {
  background: rgba(56, 189, 248, 0.08);
  border-color: rgba(56, 189, 248, 0.3);
  animation: blink 1s infinite;
}

.phase-cell.ph-fail {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.2);
}

.phase-cell.ph-skip {
  opacity: 0.3;
}

.phase-cell.ph-wait {
  opacity: 0.6;
}

.phase-icon {
  font-size: 11px;
  line-height: 1;
  margin-bottom: 1px;
}

.phase-cell.ph-done .phase-icon {
  color: var(--green);
}

.phase-cell.ph-run .phase-icon {
  color: var(--accent);
}

.phase-cell.ph-fail .phase-icon {
  color: var(--red);
}

.phase-num {
  font-size: 9px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.phase-name {
  font-size: 9px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  max-width: 100%;
  text-overflow: ellipsis;
}

.phase-role {
  font-size: 8px;
  font-weight: 600;
  margin-top: 1px;
}

.gates-row {
  display: flex;
  gap: 8px;
}

.gate {
  font-size: 11px;
  color: var(--text-muted);
}

.gate.ok {
  color: var(--green);
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
