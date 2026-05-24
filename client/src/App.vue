<template>
  <div class="app-root">
    <nav class="app-nav">
      <RouterLink to="/" class="nav-brand">🎭 Jonggrang</RouterLink>
      <div class="nav-links">
        <RouterLink to="/" class="nav-link">Projects</RouterLink>
        <RouterLink to="/settings" class="nav-link">Settings</RouterLink>
        <RouterLink to="/legacy" class="nav-link nav-link--secondary">Legacy UI</RouterLink>
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

const ws = useWsStore();
const connected = computed(() => ws.connected);

onMounted(() => ws.connect());
</script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #0a0b0f;
  color: #e4e4e7;
  font-size: 14px;
}
#app { height: 100%; display: flex; flex-direction: column; }

.app-root { display: flex; flex-direction: column; height: 100vh; }
.app-nav {
  display: flex; align-items: center; gap: 16px;
  padding: 0 20px; height: 48px;
  background: #111218; border-bottom: 1px solid #1e1f2a;
  flex-shrink: 0;
}
.nav-brand { font-weight: 700; font-size: 16px; color: #a78bfa; text-decoration: none; margin-right: 8px; }
.nav-links { display: flex; gap: 4px; flex: 1; }
.nav-link {
  padding: 4px 12px; border-radius: 6px; text-decoration: none; color: #9ca3af;
  font-size: 13px; transition: color 0.15s, background 0.15s;
}
.nav-link:hover { color: #e4e4e7; background: #1e1f2a; }
.nav-link.router-link-active { color: #a78bfa; background: #1a1a2e; }
.nav-link--secondary { color: #4b5563; }
.nav-link--secondary:hover { color: #9ca3af; }
.nav-status { font-size: 11px; font-family: monospace; }
.nav-status--ok { color: #10b981; }
.nav-status--off { color: #6b7280; }

.app-main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

/* Common layout utilities */
.page { padding: 24px; overflow-y: auto; height: 100%; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.page-title { font-size: 20px; font-weight: 600; color: #f4f4f5; }
.page-subtitle { font-size: 13px; color: #6b7280; margin-top: 4px; }

/* Button styles */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer;
  font-size: 13px; font-weight: 500; transition: all 0.15s;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn--primary { background: #7c3aed; color: #fff; }
.btn--primary:hover:not(:disabled) { background: #6d28d9; }
.btn--secondary { background: #1e1f2a; color: #9ca3af; border: 1px solid #2d2f3e; }
.btn--secondary:hover:not(:disabled) { background: #2d2f3e; color: #e4e4e7; }
.btn--danger { background: #7f1d1d; color: #fca5a5; }
.btn--danger:hover:not(:disabled) { background: #991b1b; }
.btn--sm { padding: 4px 10px; font-size: 12px; }

/* Card */
.card { background: #111218; border: 1px solid #1e1f2a; border-radius: 10px; padding: 16px; }

/* Badge */
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
}
.badge--idle        { background: #1e1f2a; color: #6b7280; }
.badge--draft       { background: #1e3a5f; color: #60a5fa; }
.badge--tasks_pending { background: #312e2e; color: #fbbf24; }
.badge--working     { background: #1a2e1a; color: #34d399; }
.badge--done        { background: #1a2e1a; color: #10b981; }
.badge--error       { background: #2e1a1a; color: #f87171; }
.badge--importing   { background: #1e1f2a; color: #a78bfa; }
.badge--initializing { background: #1e1f2a; color: #f59e0b; }
.badge--ready       { background: #1a2e1a; color: #34d399; }
.badge--imported    { background: #1e1f2a; color: #60a5fa; }

/* Form elements */
input[type="text"], input[type="url"], select, textarea {
  background: #0a0b0f; border: 1px solid #2d2f3e; border-radius: 6px;
  color: #e4e4e7; padding: 8px 12px; font-size: 13px; width: 100%;
  outline: none; transition: border-color 0.15s;
}
input:focus, select:focus, textarea:focus { border-color: #7c3aed; }
label { font-size: 12px; color: #9ca3af; display: block; margin-bottom: 4px; }
.form-group { margin-bottom: 16px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.error-text { color: #f87171; font-size: 12px; margin-top: 4px; }
</style>
