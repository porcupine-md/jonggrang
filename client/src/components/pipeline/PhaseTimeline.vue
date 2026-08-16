<template>
  <div class="timeline-wrap">
    <div class="tl-header">
      <span class="tl-title">Pipeline Phases</span>
      <Tag v-if="manifest.data" :value="manifest.data.work_type || '—'" :severity="workTypeSeverity" size="small" />
      <Tag v-if="manifest.data" :value="manifest.data.status" :severity="statusSeverity" size="small" />
      <Tag v-if="manifest.isCompact" value="compact" severity="warn" size="small" />
    </div>

    <div v-if="!manifest.data" class="tl-empty">
      <i class="pi pi-sitemap tl-empty-icon" />
      <p>No pipeline data yet.</p>
      <p class="tl-empty-hint">Run <code>jonggrang work</code> to start.</p>
    </div>

    <div v-else class="tl-scroll">
      <Timeline :value="manifest.phases" class="tl-timeline">
        <template #marker="{ item }">
          <span class="tl-marker" :class="`tl-marker--${item.status}`">
            <i v-if="item.status === 'completed'" class="pi pi-check" />
            <i v-else-if="item.status === 'in_progress'" class="pi pi-spin pi-spinner" />
            <i v-else-if="item.status === 'skipped'" class="pi pi-minus" />
            <i v-else-if="item.status === 'deferred'" class="pi pi-clock" />
            <i v-else class="pi pi-circle" />
          </span>
        </template>

        <template #content="{ item }">
          <div class="tl-item" :class="`tl-item--${item.status}`">
            <div class="tl-item-main">
              <span class="tl-num">#{{ item.num }}</span>
              <span class="tl-name">{{ item.name }}</span>
              <Tag
                :value="item.role"
                :severity="roleSeverity(item.role)"
                size="small"
                class="tl-role"
              />
              <span v-if="item.status === 'in_progress'" class="tl-badge-running">
                <i class="pi pi-spin pi-spinner" style="font-size:10px" /> running
              </span>
            </div>
            <div v-if="item.status === 'skipped'" class="tl-skip">
              skipped for {{ skippedBy(item.num, manifest.data.work_type) }}
            </div>
            <div v-else-if="item.status === 'deferred'" class="tl-skip">
              deferred by compact mode — run the quality gates to execute it
            </div>
            <div v-if="item.completed_at" class="tl-time">
              {{ fmtTime(item.completed_at) }}
            </div>
          </div>
        </template>
      </Timeline>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import Timeline from 'primevue/timeline';
import Tag from 'primevue/tag';
import { useManifestStore } from '../../stores/manifest.js';

const manifest = useManifestStore();

const SKIP_MAP = {
  5: ['BUGFIX', 'SMALL'], 6: ['BUGFIX', 'SMALL'], 7: ['BUGFIX', 'SMALL'],
  9: ['BUGFIX', 'SMALL'], 12: ['BUGFIX'],
};

const workTypeSeverity = computed(() => {
  const wt = (manifest.data?.work_type || '').toLowerCase();
  return { bugfix: 'danger', small: 'info', medium: 'success', large: 'warn' }[wt] || 'secondary';
});

const statusSeverity = computed(() => ({
  in_progress: 'warn', done: 'success',
}[manifest.data?.status] || 'secondary'));

function roleSeverity(role) {
  return {
    Lead: 'info', Developer: 'success', Reviewer: 'secondary',
    'Test Lead': 'warn', Tester: 'warn',
  }[role] || 'secondary';
}

function skippedBy(num, workType) {
  return workType || (SKIP_MAP[num] ? SKIP_MAP[num].join('/') : '');
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString() : '';
}
</script>

<style scoped>
.timeline-wrap {
  display: flex; flex-direction: column; height: 100%;
  background: var(--jg-card);
}

.tl-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; border-bottom: 1px solid var(--jg-border);
  flex-shrink: 0;
}
.tl-title {
  font-size: 11px; font-weight: 600;
  color: var(--jg-text-faint); flex: 1;
  text-transform: uppercase; letter-spacing: 0.07em;
}

.tl-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; padding: 24px;
  color: var(--jg-text-faint); text-align: center;
}
.tl-empty-icon { font-size: 28px; margin-bottom: 4px; }
.tl-empty p { font-size: 12px; }
.tl-empty-hint { font-size: 11px; opacity: 0.7; }
.tl-empty code {
  background: var(--jg-hover);
  padding: 1px 6px; border-radius: 0px;
  font-size: 11px; color: var(--jg-green);
}

.tl-scroll { flex: 1; overflow-y: auto; padding: 8px 8px 16px; }

/* PrimeVue Timeline overrides */
.tl-timeline :deep(.p-timeline-event-opposite) { display: none; }
.tl-timeline :deep(.p-timeline-event-connector) {
  background: var(--jg-border);
  width: 1px;
}
.tl-timeline :deep(.p-timeline-event) { min-height: 36px; }
.tl-timeline :deep(.p-timeline-event-content) { padding-bottom: 6px; }

/* Marker — always circular */
.tl-marker {
  width: 20px; height: 20px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; flex-shrink: 0;
  border: 1.5px solid var(--jg-border);
  background: transparent;
  color: var(--jg-text-faint);
  transition: background 0.15s, border-color 0.15s;
}
.tl-marker--completed {
  background: var(--jg-green);
  border-color: var(--jg-green);
  color: oklch(0.12 0.04 145);
  font-size: 8px;
}
.tl-marker--in_progress {
  border-color: var(--jg-orange);
  color: var(--jg-orange);
}
.tl-marker--skipped {
  opacity: 0.3;
}
.tl-marker--deferred {
  border-color: var(--jg-orange);
  color: var(--jg-orange);
  opacity: 0.7;
}

/* Content */
.tl-item {
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px 0;
}
.tl-item--skipped { opacity: 0.4; }
.tl-item--in_progress .tl-name { color: var(--jg-orange); }

.tl-item-main {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.tl-num {
  font-size: 10px;
  color: var(--jg-text-faint); flex-shrink: 0; min-width: 24px;
}
.tl-name {
  font-size: 12px; color: var(--jg-text); flex: 1; min-width: 0;
}
.tl-item--skipped .tl-name { text-decoration: line-through; }
.tl-role { flex-shrink: 0; }

.tl-badge-running {
  font-size: 10px; color: var(--jg-orange);
  display: flex; align-items: center; gap: 3px;
}

.tl-skip {
  font-size: 10px; color: var(--jg-text-faint);
  padding-left: 32px;
}
.tl-time {
  font-size: 10px; color: var(--jg-text-faint);
  padding-left: 32px;
}
</style>
