<template>
  <div class="ft">
    <div
      class="ft-row" :class="{ 'ft-active': api.activePath.value === node.path && node.type === 'file' }"
      :style="{ paddingLeft: (depth * 12 + 8) + 'px' }"
      @click="toggle"
    >
      <i v-if="node.type === 'dir'" class="ft-ico" :class="open ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
      <i class="ft-ico" :class="node.type === 'dir' ? (open ? 'pi pi-folder-open' : 'pi pi-folder') : 'pi pi-file'" />
      <span class="ft-name">{{ node.name }}</span>
    </div>
    <div v-if="open && loading" class="ft-loading" :style="{ paddingLeft: ((depth + 1) * 12 + 22) + 'px' }">…</div>
    <template v-if="open && children">
      <FileTree v-for="c in children" :key="c.path" :node="c" :depth="depth + 1" />
    </template>
  </div>
</template>

<script setup>
import { ref, inject } from 'vue';

const props = defineProps({
  node: { type: Object, required: true },   // { name, type, path }
  depth: { type: Number, default: 0 },
});

const api = inject('filesApi');
const open = ref(false);
const loading = ref(false);
const children = ref(null);

async function toggle() {
  if (props.node.type === 'file') { api.open(props.node.path); return; }
  open.value = !open.value;
  if (open.value && children.value === null) {
    loading.value = true;
    children.value = await api.list(props.node.path);
    loading.value = false;
  }
}
</script>

<style scoped>
.ft-row {
  display: flex; align-items: center; gap: 5px; padding: 3px 8px;
  cursor: pointer; font-size: 12px; color: var(--jg-text-muted); white-space: nowrap;
}
.ft-row:hover { background: var(--jg-hover); }
.ft-active { background: color-mix(in oklch, var(--jg-green) 12%, transparent); color: var(--jg-green); }
.ft-ico { font-size: 11px; flex-shrink: 0; }
.ft-row .pi-folder, .ft-row .pi-folder-open { color: var(--jg-cyan); }
.ft-name { overflow: hidden; text-overflow: ellipsis; }
.ft-loading { font-size: 11px; color: var(--jg-text-faint); padding: 2px 8px; }
</style>
