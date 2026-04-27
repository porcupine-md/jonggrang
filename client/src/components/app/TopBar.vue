<script setup>
import {
  PlayIcon,
  SquareIcon,
  LayoutGridIcon,
  GitBranchIcon,
  ChevronDownIcon,
  FileTextIcon,
  EyeIcon,
  BookOpenIcon,
  ActivityIcon,
} from 'lucide-vue-next';

defineProps({
  projectName: {
    type: String,
    required: true,
  },
  currentView: {
    type: String,
    required: true,
  },
  ctxPct: {
    type: Number,
    default: null,
  },
  isRunning: {
    type: Boolean,
    default: false,
  },
  hasPendingPlan: {
    type: Boolean,
    default: false,
  },
});

defineEmits([
  'select-view',
  'open-plan',
  'start-review',
  'open-work',
  'stop-work',
  'toggle-logs',
]);
</script>

<template>
  <header class="topbar">
    <div class="topbar-left">
      <span class="project-name">{{ projectName }}</span>
      <ChevronDownIcon :size="13" class="icon-muted" />
    </div>

    <div class="topbar-center">
      <button :class="['tab', { active: currentView === 'kanban' }]" @click="$emit('select-view', 'kanban')" title="Task Board" aria-label="Task Board">
        <LayoutGridIcon :size="15" />
      </button>
      <button :class="['tab', { active: currentView === 'graph' }]" @click="$emit('select-view', 'graph')" title="Dependency Graph" aria-label="Dependency Graph">
        <GitBranchIcon :size="15" />
      </button>

      <div class="sep"></div>

      <button class="topbar-btn" @click="$emit('open-plan')" title="Plan feature"
        :aria-label="hasPendingPlan ? 'Plan feature (pending plan)' : 'Plan feature'"
        :class="{ 'has-pending-plan': hasPendingPlan }">
        <FileTextIcon :size="15" />
      </button>
      <button class="topbar-btn" @click="$emit('start-review')" title="Run review" aria-label="Run review">
        <EyeIcon :size="15" />
      </button>

      <div class="sep"></div>

      <button v-if="!isRunning" class="run-btn" @click="$emit('open-work')">
        <PlayIcon :size="13" /><span>Work</span>
      </button>
      <button v-else class="stop-btn" @click="$emit('stop-work')">
        <SquareIcon :size="12" /><span>Stop</span>
      </button>
    </div>

    <div class="topbar-right">
      <div
        v-if="ctxPct !== null"
        class="ctx-badge"
        :class="{ warn: ctxPct >= 75, danger: ctxPct >= 85 }"
        :title="`Context usage: ${ctxPct}%`"
      >
        <ActivityIcon :size="12" />{{ ctxPct }}%
      </div>
      <div class="status-dot" :class="{ active: isRunning }"></div>
      <span class="status-text">{{ isRunning ? 'Running' : 'Idle' }}</span>
      <button class="topbar-btn" @click="$emit('toggle-logs')" title="Toggle logs" aria-label="Toggle logs">
        <BookOpenIcon :size="15" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  gap: 8px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-subtle);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 5px;
}

.project-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
}

.icon-muted {
  color: var(--text-muted);
}

.topbar-center {
  display: flex;
  align-items: center;
  gap: 4px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 26px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.tab:hover {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

.tab.active {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--border-subtle);
  margin: 0 4px;
}

.topbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.topbar-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-secondary);
}

.topbar-btn.has-pending-plan {
  color: var(--yellow);
}

.run-btn,
.stop-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  height: 26px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}

.run-btn {
  background: var(--green);
  color: #000;
}

.run-btn:hover {
  background: #0ea271;
}

.stop-btn {
  background: var(--red-muted);
  color: var(--red);
  border: 1px solid var(--red-muted);
}

.stop-btn:hover {
  background: rgba(239, 68, 68, 0.2);
}

.ctx-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  cursor: default;
}

.ctx-badge.warn {
  color: var(--yellow);
}

.ctx-badge.danger {
  color: var(--red);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
}

.status-dot.active {
  background: var(--green);
  box-shadow: 0 0 6px var(--green);
}

.status-text {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
