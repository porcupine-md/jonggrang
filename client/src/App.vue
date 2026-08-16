<template>
  <div class="app-root">
    <nav class="app-nav">
      <RouterLink to="/" class="nav-brand">
        <span class="nav-brand-indicator"></span>
        <span class="nav-brand-path">~/</span>jonggrang
      </RouterLink>
      <div class="nav-links">
        <RouterLink to="/" class="nav-link">projects</RouterLink>
        <RouterLink to="/issues" class="nav-link">issues</RouterLink>
        <RouterLink to="/design" class="nav-link">design</RouterLink>
        <RouterLink to="/secrets" class="nav-link">secrets</RouterLink>
        <RouterLink to="/settings" class="nav-link">settings</RouterLink>
      </div>
      <div class="nav-status" :class="connected ? 'nav-status--ok' : 'nav-status--off'">
        {{ connected ? '● live' : '○ offline' }}
      </div>
    </nav>
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { useWsStore } from './stores/ws.js';
import { useTheme } from './composables/useTheme.js';

const ws = useWsStore();
const connected = computed(() => ws.connected);

useTheme(); // initialize — applies saved theme on startup

onMounted(() => ws.connect());
</script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: 'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace;
  background: var(--jg-bg);
  color: var(--jg-text);
  font-size: 13px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  transition: background 0.2s, color 0.2s;
}
#app { height: 100%; display: flex; flex-direction: column; }

.app-root { display: flex; flex-direction: column; height: 100vh; }
.app-nav {
  display: flex; align-items: center; gap: 0;
  padding: 0 16px; height: 44px;
  background: var(--jg-card);
  border-bottom: 1px solid var(--jg-border);
  flex-shrink: 0;
}
.nav-brand {
  font-size: 13px; font-weight: 500;
  color: var(--jg-text-dim);
  text-decoration: none; margin-right: 20px;
  display: flex; align-items: center; gap: 6px;
}
.nav-brand-indicator {
  width: 8px; height: 8px; border-radius: 2px;
  background: var(--jg-green); flex-shrink: 0;
}
.nav-brand-path { color: var(--jg-text-muted); }
.nav-links { display: flex; gap: 0; flex: 1; }
.nav-link {
  padding: 0 14px; height: 44px;
  display: flex; align-items: center; gap: 6px;
  text-decoration: none; color: var(--jg-text-muted);
  font-size: 12px; transition: color 0.15s, background 0.15s;
  border-right: 1px solid var(--jg-border);
}
.nav-link:first-child { border-left: 1px solid var(--jg-border); }
.nav-link:hover { color: var(--jg-text); background: var(--jg-hover); }
.nav-link.router-link-active { color: var(--jg-green); background: oklch(0.195 0.014 245); }
.nav-status { font-size: 11px; font-family: var(--font-mono); margin-left: auto; }
.nav-status--ok { color: var(--jg-green); }
.nav-status--off { color: var(--jg-text-faint); }

.app-main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

/* Common layout utilities */
.page { padding: 24px; overflow-y: auto; height: 100%; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.page-title { font-size: 16px; font-weight: 600; color: var(--jg-text); }
.page-subtitle { font-size: 12px; color: var(--jg-text-muted); margin-top: 4px; }

.form-group { margin-bottom: 16px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.error-text { color: var(--jg-red); font-size: 12px; margin-top: 4px; }
label { font-size: 12px; color: var(--jg-text-muted); display: block; margin-bottom: 4px; }
</style>
