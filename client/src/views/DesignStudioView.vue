<template>
  <div class="studio">
    <header class="st-head">
      <RouterLink to="/design" class="st-back"><i class="pi pi-arrow-left" /> Design</RouterLink>
      <span class="st-name">{{ name }}</span>
      <span class="st-badge" :class="validation.valid ? 'ok' : 'bad'">
        {{ validation.valid ? 'valid' : (validation.errors || []).length + ' errors' }}
      </span>
      <span v-if="validation.warnings && validation.warnings.length" class="st-warn">{{ validation.warnings.length }} warnings</span>
      <div class="st-spacer" />
      <select v-model="tool" class="st-select" title="Backend for the studio TUI (unsafe)">
        <option value="shell">shell</option>
        <option value="claude">claude</option>
        <option value="opencode">opencode</option>
        <option value="codex">codex</option>
        <option value="jonggrang">jonggrang</option>
      </select>
      <Button v-if="!isRunning" size="small" :disabled="starting" @click="startTerminal">
        <i class="pi pi-play" /> {{ starting ? 'Starting…' : 'Start TUI' }}
      </Button>
      <Button v-else size="small" severity="danger" @click="stopTerminal"><i class="pi pi-stop" /> Stop</Button>
    </header>

    <div class="st-body">
      <!-- Left: the tool's native interactive TUI (unsafe) -->
      <section class="st-pane st-left">
        <div class="st-pane-label">TUI · {{ tool }} <span class="dim">(unsafe · cwd = template)</span></div>
        <div ref="terminalRef" class="st-terminal" />
      </section>

      <!-- Right: live preview + token editor + components -->
      <section class="st-pane st-right">
        <div class="st-preview-bar">
          <span class="st-pane-label">Preview</span>
          <select v-model="component" class="st-select">
            <option value="">all components</option>
            <option v-for="c in components" :key="c.id" :value="c.id">{{ c.id }}</option>
          </select>
          <select v-model="theme" class="st-select">
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
          <select v-model.number="width" class="st-select">
            <option :value="375">375</option>
            <option :value="768">768</option>
            <option :value="1024">1024</option>
            <option :value="1280">1280</option>
          </select>
        </div>
        <iframe :src="previewSrc" class="st-preview" sandbox="allow-same-origin" title="preview" />

        <div class="st-editor">
          <div class="st-editor-head">
            <span class="st-pane-label">tokens.css.template</span>
            <Button size="small" :disabled="saving" @click="saveTokens">{{ saving ? 'Saving…' : 'Save' }}</Button>
          </div>
          <textarea v-model="tokenText" class="st-textarea" spellcheck="false" />
          <p v-if="lintMsg" class="st-lint" :class="validation.valid ? 'ok' : 'bad'">{{ lintMsg }}</p>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import Button from 'primevue/button';
import '@xterm/xterm/css/xterm.css';
import { useWsStore } from '../stores/ws.js';
import { useInteractiveTerminal } from '../composables/useInteractiveTerminal.js';

const route = useRoute();
const name = computed(() => route.params.name);
const ws = useWsStore();

const components = ref([]);
const validation = ref({ valid: true, errors: [], warnings: [] });
const tokenText = ref('');
const tool = ref('shell');
const component = ref('');
const theme = ref('light');
const width = ref(1024);
const nonce = ref(0);
const starting = ref(false);
const saving = ref(false);
const lintMsg = ref('');

const previewSrc = computed(() =>
  `/api/design/${encodeURIComponent(name.value)}/preview?theme=${theme.value}&width=${width.value}` +
  (component.value ? `&component=${encodeURIComponent(component.value)}` : '') + `&_=${nonce.value}`);

const { terminalRef, isRunning, markRunning, markStopped } = useInteractiveTerminal({
  projectId: computed(() => `design:${name.value}`),
  session: 'design',
  getSocket: () => ws.socket,
});

async function load() {
  const res = await fetch(`/api/design/${encodeURIComponent(name.value)}`);
  if (!res.ok) return;
  const t = await res.json();
  components.value = t.components || [];
  tokenText.value = t.tokenTemplate || '';
  validation.value = t.validation || { valid: true, errors: [], warnings: [] };
}

function reloadPreview() { nonce.value = Date.now(); }

async function saveTokens() {
  saving.value = true; lintMsg.value = '';
  try {
    const res = await fetch(`/api/design/${encodeURIComponent(name.value)}/file`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'tokens.css.template', content: tokenText.value }),
    });
    const body = await res.json();
    if (body.validation) validation.value = body.validation;
    lintMsg.value = body.validation && body.validation.valid ? 'Saved · valid' : 'Saved · ' + ((body.validation && body.validation.errors) || []).join('; ');
    reloadPreview();
  } catch (e) { lintMsg.value = String(e); }
  saving.value = false;
}

async function startTerminal() {
  starting.value = true;
  try {
    const el = terminalRef.value;
    const cols = el ? Math.floor(el.clientWidth / 7.5) : 80;
    const rows = el ? Math.floor(el.clientHeight / 17) : 24;
    const res = await fetch(`/api/design/${encodeURIComponent(name.value)}/terminal/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows, tool: tool.value }),
    });
    if (res.ok) markRunning();
  } catch { /* ignore */ }
  starting.value = false;
}

async function stopTerminal() {
  await fetch(`/api/design/${encodeURIComponent(name.value)}/terminal/stop`, { method: 'POST' });
  markStopped();
}

onMounted(() => {
  ws.connect();
  load();
  const s = ws.socket;
  if (s) s.on('design.changed', (p) => { if (p && p.name === name.value) { load(); reloadPreview(); } });
});
</script>

<style scoped>
.studio { display: flex; flex-direction: column; height: calc(100vh - 48px); color: var(--text, #ebe5db); }
.st-head { display: flex; align-items: center; gap: .6rem; padding: .6rem 1rem; border-bottom: 1px solid #2d3748; }
.st-back { color: var(--text-muted, #8a8f98); text-decoration: none; font-size: .85rem; }
.st-name { font-weight: 600; }
.st-badge { font-size: .65rem; padding: .1rem .45rem; border-radius: 4px; }
.st-badge.ok { background: rgba(74,222,128,.15); color: #4ade80; }
.st-badge.bad { background: rgba(248,113,113,.15); color: #f87171; }
.st-warn { font-size: .65rem; color: #fbbf24; }
.st-spacer { flex: 1; }
.st-select { background: #141b24; border: 1px solid #2d3748; color: inherit; border-radius: 6px; padding: .25rem .4rem; font-size: .8rem; }
.st-body { flex: 1; display: flex; min-height: 0; }
.st-pane { display: flex; flex-direction: column; min-width: 0; }
.st-left { width: 46%; border-right: 1px solid #2d3748; }
.st-right { flex: 1; }
.st-pane-label { font: 600 .68rem/1.4 system-ui; letter-spacing: .04em; text-transform: uppercase; color: var(--text-muted, #8a8f98); }
.dim { color: #5b6472; text-transform: none; letter-spacing: 0; }
.st-terminal { flex: 1; min-height: 0; background: #0f1520; padding: .4rem; }
.st-preview-bar { display: flex; align-items: center; gap: .5rem; padding: .5rem .75rem; border-bottom: 1px solid #2d3748; }
.st-preview { flex: 1; min-height: 0; border: 0; background: #fff; }
.st-editor { border-top: 1px solid #2d3748; display: flex; flex-direction: column; height: 40%; }
.st-editor-head { display: flex; align-items: center; justify-content: space-between; padding: .4rem .75rem; }
.st-textarea { flex: 1; resize: none; background: #0f1520; color: #ebe5db; border: 0; padding: .5rem .75rem; font-family: "JetBrains Mono", monospace; font-size: .78rem; }
.st-lint { padding: .3rem .75rem; font-size: .72rem; }
.st-lint.ok { color: #4ade80; } .st-lint.bad { color: #f87171; }
</style>
