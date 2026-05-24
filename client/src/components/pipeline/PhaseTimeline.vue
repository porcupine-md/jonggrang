<template>
  <div class="timeline">
    <div class="timeline-header">
      <div class="tl-title">Pipeline Phases</div>
      <span v-if="manifest.data" class="work-type-badge" :class="`wt--${(manifest.data.work_type || '').toLowerCase()}`">
        {{ manifest.data.work_type || '—' }}
      </span>
      <span v-if="manifest.data" class="status-badge" :class="`ms--${manifest.data.status}`">
        {{ manifest.data.status }}
      </span>
    </div>

    <div v-if="!manifest.data" class="tl-empty">
      No pipeline data yet. Run <code>jonggrang work</code> to start.
    </div>

    <div v-else class="tl-phases">
      <div
        v-for="phase in manifest.phases"
        :key="phase.num"
        class="phase-row"
        :class="`phase--${phase.status}`"
      >
        <div class="phase-icon">
          <span v-if="phase.status === 'completed'">✓</span>
          <span v-else-if="phase.status === 'in_progress'" class="pulse">◉</span>
          <span v-else-if="phase.status === 'skipped'">—</span>
          <span v-else>○</span>
        </div>
        <div class="phase-num">{{ phase.num }}</div>
        <div class="phase-info">
          <span class="phase-name">{{ phase.name }}</span>
          <span v-if="phase.status === 'in_progress'" class="phase-running">running</span>
          <span v-if="phase.status === 'skipped'" class="phase-skip-reason">skipped ({{ skippedBy(phase.num, manifest.data.work_type) }})</span>
        </div>
        <div class="phase-role" :class="`role--${phase.role.toLowerCase().replace('-', '')}`">
          {{ phase.role }}
        </div>
        <div class="phase-time" v-if="phase.completed_at">
          {{ fmtTime(phase.completed_at) }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useManifestStore } from '../../stores/manifest.js';

const manifest = useManifestStore();

const SKIP_MAP = {
  5: ['BUGFIX', 'SMALL'], 6: ['BUGFIX', 'SMALL'], 7: ['BUGFIX', 'SMALL'],
  9: ['BUGFIX', 'SMALL'], 12: ['BUGFIX'],
};

function skippedBy(num, workType) {
  return workType || (SKIP_MAP[num] ? SKIP_MAP[num].join('/') : '');
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : '';
}
</script>

<style scoped>
.timeline { display: flex; flex-direction: column; height: 100%; }

.timeline-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid #1e1f2a; flex-shrink: 0;
}
.tl-title { font-size: 12px; font-weight: 600; color: #9ca3af; flex: 1; }

.work-type-badge {
  font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.wt--bugfix  { background: #7f1d1d; color: #fca5a5; }
.wt--small   { background: #1e3a5f; color: #93c5fd; }
.wt--medium  { background: #14532d; color: #86efac; }
.wt--large   { background: #312e81; color: #c4b5fd; }

.status-badge {
  font-size: 10px; padding: 2px 7px; border-radius: 10px; text-transform: capitalize;
}
.ms--in_progress { background: #92400e; color: #fcd34d; }
.ms--done        { background: #065f46; color: #6ee7b7; }

.tl-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #4b5563; text-align: center; padding: 24px;
}
.tl-empty code { background: #1e1f2a; padding: 2px 6px; border-radius: 4px; }

.tl-phases { flex: 1; overflow-y: auto; padding: 8px 0; }

.phase-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 16px; border-left: 2px solid transparent;
  transition: background 0.1s;
}
.phase-row:hover { background: #0d0e14; }

.phase--completed  { border-left-color: #065f46; }
.phase--in_progress { border-left-color: #d97706; background: #0f0e08; }
.phase--skipped    { opacity: 0.35; }
.phase--pending    { opacity: 0.6; }

.phase-icon { width: 16px; text-align: center; font-size: 12px; flex-shrink: 0; }
.phase--completed .phase-icon  { color: #10b981; }
.phase--in_progress .phase-icon { color: #f59e0b; }
.phase--skipped .phase-icon    { color: #4b5563; }
.phase--pending .phase-icon    { color: #374151; }

.phase-num { width: 20px; font-size: 10px; font-family: monospace; color: #4b5563; flex-shrink: 0; }

.phase-info { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
.phase-name { font-size: 12px; color: #d1d5db; }
.phase--skipped .phase-name { text-decoration: line-through; color: #4b5563; }
.phase-running { font-size: 10px; color: #f59e0b; }
.phase-skip-reason { font-size: 10px; color: #4b5563; }

.phase-role {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  flex-shrink: 0; font-weight: 500;
}
.role--lead       { background: #1e3a5f; color: #93c5fd; }
.role--developer  { background: #14532d; color: #86efac; }
.role--reviewer   { background: #312e81; color: #c4b5fd; }
.role--testlead   { background: #7c2d12; color: #fdba74; }
.role--tester     { background: #3b0764; color: #e9d5ff; }

.phase-time { font-size: 10px; color: #4b5563; flex-shrink: 0; }

.pulse { animation: blink 1s ease-in-out infinite; display: inline-block; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
</style>
