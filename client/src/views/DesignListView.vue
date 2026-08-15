<template>
  <div class="design-list">
    <header class="dl-head">
      <div>
        <h1>Design</h1>
        <p class="dl-sub">Global design templates · {{ root }}</p>
      </div>
      <div class="dl-actions">
        <Button size="small" @click="showNew = !showNew"><i class="pi pi-plus" /> New template</Button>
        <Button size="small" severity="secondary" @click="showPromote = !showPromote"><i class="pi pi-upload" /> Promote from project</Button>
      </div>
    </header>

    <div v-if="showNew" class="dl-form">
      <input v-model="nf.name" placeholder="template-name (kebab-case)" />
      <input v-model="nf.intent" placeholder="intent (optional)" />
      <input v-model="nf.shapes" placeholder="shapes: dashboard,landing-page (optional)" />
      <Button size="small" @click="createTemplate">Create</Button>
    </div>
    <div v-if="showPromote" class="dl-form">
      <input v-model="pf.name" placeholder="template-name (kebab-case)" />
      <input v-model="pf.from" placeholder="project path (with .jonggrang/UI.md)" />
      <Button size="small" @click="promote">Promote</Button>
    </div>
    <p v-if="error" class="dl-error">{{ error }}</p>

    <div v-if="!templates.length" class="dl-empty">No templates yet — create one, or promote a project's design.</div>
    <div class="dl-grid">
      <div v-for="t in templates" :key="t.key" class="dl-card">
        <RouterLink :to="`/design/${t.id}`" class="dl-card-main">
          <div class="dl-card-top">
            <span class="dl-name">{{ t.id }}</span>
            <span class="dl-badge" :class="t.valid ? 'ok' : 'bad'">{{ t.valid ? t.key : 'invalid' }}</span>
          </div>
          <p class="dl-intent">{{ t.intent || '—' }}</p>
          <p class="dl-meta">{{ (t.components || []).length }} components · {{ (t.product_shapes || []).join(', ') || 'any' }}</p>
        </RouterLink>
        <button class="dl-del" title="Delete" @click="remove(t.id)"><i class="pi pi-trash" /></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';

const templates = ref([]);
const root = ref('');
const error = ref('');
const showNew = ref(false);
const showPromote = ref(false);
const nf = ref({ name: '', intent: '', shapes: '' });
const pf = ref({ name: '', from: '' });

async function load() {
  error.value = '';
  const res = await fetch('/api/design');
  const data = await res.json();
  templates.value = data.templates || [];
  root.value = data.root || '';
}

async function createTemplate() {
  error.value = '';
  const body = { name: nf.value.name.trim(), intent: nf.value.intent.trim() || undefined,
    product_shapes: nf.value.shapes ? nf.value.shapes.split(',').map(s => s.trim()).filter(Boolean) : undefined };
  const res = await fetch('/api/design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { error.value = (await res.json()).error; return; }
  showNew.value = false; nf.value = { name: '', intent: '', shapes: '' }; await load();
}

async function promote() {
  error.value = '';
  const res = await fetch('/api/design/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: pf.value.name.trim(), fromProjectPath: pf.value.from.trim() }) });
  if (!res.ok) { error.value = (await res.json()).error; return; }
  showPromote.value = false; pf.value = { name: '', from: '' }; await load();
}

async function remove(name) {
  if (!window.confirm(`Delete design template "${name}"?`)) return;
  await fetch(`/api/design/${encodeURIComponent(name)}`, { method: 'DELETE' });
  await load();
}

onMounted(load);
</script>

<style scoped>
.design-list { padding: 1.5rem 2rem; color: var(--text, #ebe5db); }
.dl-head { display: flex; justify-content: space-between; align-items: flex-start; }
.dl-head h1 { font-size: 1.4rem; }
.dl-sub { color: var(--text-muted, #8a8f98); font-size: .8rem; margin-top: .25rem; }
.dl-actions { display: flex; gap: .5rem; }
.dl-form { display: flex; gap: .5rem; margin-top: 1rem; flex-wrap: wrap; }
.dl-form input { flex: 1; min-width: 180px; padding: .4rem .6rem; background: #141b24; border: 1px solid #2d3748; border-radius: 6px; color: inherit; }
.dl-error { color: #f87171; margin-top: .5rem; }
.dl-empty { color: var(--text-muted, #8a8f98); margin-top: 2rem; }
.dl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; margin-top: 1.25rem; }
.dl-card { position: relative; border: 1px solid #2d3748; border-radius: 8px; background: #141b24; }
.dl-card-main { display: block; padding: 1rem; color: inherit; text-decoration: none; }
.dl-card-top { display: flex; justify-content: space-between; align-items: center; }
.dl-name { font-weight: 600; }
.dl-badge { font-size: .65rem; padding: .1rem .4rem; border-radius: 4px; }
.dl-badge.ok { background: rgba(74,222,128,.15); color: #4ade80; }
.dl-badge.bad { background: rgba(248,113,113,.15); color: #f87171; }
.dl-intent { color: var(--text-muted, #8a8f98); font-size: .8rem; margin-top: .5rem; }
.dl-meta { color: #5b6472; font-size: .72rem; margin-top: .4rem; }
.dl-del { position: absolute; top: .6rem; right: .6rem; background: none; border: none; color: #5b6472; cursor: pointer; opacity: 0; transition: opacity .15s; }
.dl-card:hover .dl-del { opacity: 1; }
.dl-del:hover { color: #f87171; }
</style>
