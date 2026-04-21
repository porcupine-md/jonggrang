<script setup>
import { VueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import { getStatusColor, getStatusLabel } from '../../utils/appUi';

defineProps({
  graphNodes: {
    type: Object,
    required: true,
  },
});

defineEmits(['select-task']);
</script>

<template>
  <div class="graph-wrap">
    <VueFlow :nodes="graphNodes.nodes" :edges="graphNodes.edges" :default-viewport="{ zoom: 0.85, x: 0, y: 0 }" fit-view-on-init>
      <Background :gap="24" :size="1" pattern-color="rgba(255,255,255,0.03)" />
      <Controls position="bottom-left" />
      <MiniMap position="bottom-right" />
      <template #node-taskNode="{ data }">
        <div :class="['gnode', `gnode--${data.status}`]" @click="$emit('select-task', data)">
          <div class="gnode-id">{{ data.id }}</div>
          <div class="gnode-title">{{ data.title }}</div>
          <div class="gnode-status" :style="{ color: getStatusColor(data.status) }">{{ getStatusLabel(data.status) }}</div>
        </div>
      </template>
    </VueFlow>
  </div>
</template>

<style scoped>
.graph-wrap {
  flex: 1;
  overflow: hidden;
}

.gnode {
  padding: 12px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  min-width: 180px;
  cursor: pointer;
}

.gnode:hover {
  border-color: var(--border-default);
}

.gnode--completed {
  border-color: rgba(16, 185, 129, 0.3);
}

.gnode--in_progress {
  border-color: rgba(59, 130, 246, 0.4);
  animation: pulse 2s infinite;
}

.gnode--blocked {
  border-color: rgba(239, 68, 68, 0.3);
}

.gnode-id {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  margin-bottom: 4px;
}

.gnode-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.gnode-status {
  font-size: 11px;
  font-weight: 600;
  text-transform: capitalize;
}

@keyframes pulse {
  0%,
  100% { box-shadow: none; }
  50% { box-shadow: 0 0 12px 2px rgba(59, 130, 246, 0.1); }
}
</style>
