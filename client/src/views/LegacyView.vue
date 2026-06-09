<template>
  <div class="legacy-wrap">
    <p>Legacy single-project UI is no longer embedded here.</p>
    <p>Use the Projects list to open a specific project.</p>
    <RouterLink to="/" class="legacy-back">← Back to Projects</RouterLink>
  </div>
</template>
<script setup>
import { RouterLink } from 'vue-router';
</script>
<style scoped>
.legacy-wrap { padding: 24px; color: var(--jg-text-muted); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
.legacy-back { color: var(--jg-green); text-decoration: none; margin-top: 4px; display: inline-block; }
.legacy-back:hover { color: var(--jg-text); }
</style>
