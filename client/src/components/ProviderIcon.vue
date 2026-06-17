<template>
  <Gitlab v-if="provider === 'gitlab'" :size="size" class="prov-svg" />
  <Github v-else :size="size" class="prov-svg" />
</template>

<script setup>
// PrimeIcons ships pi-github but has no pi-gitlab, so provider icons come from
// lucide-vue-next (which has both, in a consistent line style). Inherits
// currentColor so badge/tab colors apply.
import { Github, Gitlab } from 'lucide-vue-next';

defineProps({
  provider: { type: String, default: 'github' },
  size: { type: [Number, String], default: 13 },
});
</script>

<style scoped>
.prov-svg { display: inline-block; vertical-align: -0.15em; }
</style>
