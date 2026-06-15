<template>
  <div class="drawer-overlay" @click.self="$emit('close')">
    <div class="drawer">
      <div class="drawer-header">
        <div class="drawer-head-left">
          <span class="prov-badge" :class="`prov-badge--${basic.provider}`">
            <i :class="basic.provider === 'github' ? 'pi pi-github' : 'pi pi-gitlab'" />
            {{ basic.repo }}#{{ basic.number }}
          </span>
        </div>
        <button class="drawer-close" @click="$emit('close')"><i class="pi pi-times" /></button>
      </div>

      <div v-if="loading" class="drawer-loading"><i class="pi pi-spin pi-spinner" /> Loading issue…</div>
      <div v-else-if="error" class="drawer-error"><i class="pi pi-exclamation-triangle" /> {{ error }}</div>

      <div v-else-if="issue" class="drawer-body">
        <div class="issue-title-row">
          <span class="state-dot" :class="`state-dot--${issue.state}`" />
          <h2 class="issue-title">{{ issue.title }}</h2>
        </div>
        <div class="issue-meta">
          <span class="badge" :class="`badge--${issue.state}`">{{ issue.state }}</span>
          <span v-if="issue.author" class="meta-dim">by @{{ issue.author }}</span>
          <span v-if="issue.updated_at" class="meta-dim">· updated {{ formatDate(issue.updated_at) }}</span>
        </div>
        <div v-if="issue.labels?.length" class="issue-labels">
          <span v-for="l in issue.labels" :key="l" class="label-chip">{{ l }}</span>
        </div>
        <div v-if="issue.assignees?.length" class="issue-assignees">
          Assignees: <span v-for="a in issue.assignees" :key="a" class="assignee">@{{ a }}</span>
        </div>

        <div class="md-content" v-html="renderedBody" />

        <div v-if="issue.comments?.length" class="comments">
          <div class="comments-title">Comments ({{ issue.comments.length }})</div>
          <div v-for="(c, i) in issue.comments" :key="i" class="comment">
            <div class="comment-head">@{{ c.author || 'unknown' }} · {{ formatDate(c.created_at) }}</div>
            <div class="md-content comment-body" v-html="renderComment(c.body)" />
          </div>
        </div>
      </div>

      <div class="drawer-footer">
        <a :href="basic.url || issue?.url" target="_blank" rel="noopener" class="open-orig">
          <i class="pi pi-external-link" /> Open original
        </a>
        <Button @click="$emit('pickup', basic)"><i class="pi pi-arrow-right" /> Pickup → Plan</Button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import Button from 'primevue/button';
import { marked } from 'marked';
import { useIssuesStore } from '../../stores/issues.js';

const props = defineProps({ basic: { type: Object, required: true } });
defineEmits(['close', 'pickup']);

const store = useIssuesStore();
const issue = ref(null);
const loading = ref(true);
const error = ref('');

const renderedBody = computed(() => marked.parse(issue.value?.body || '_(no description)_'));
function renderComment(b) { return marked.parse(b || ''); }

function formatDate(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return s; }
}

onMounted(async () => {
  try {
    issue.value = await store.fetchDetail(props.basic.provider, props.basic.repo, props.basic.number);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; justify-content: flex-end; z-index: 50; }
.drawer { width: 560px; max-width: 92vw; height: 100%; background: var(--jg-card); border-left: 1px solid var(--jg-border); display: flex; flex-direction: column; }
.drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--jg-border); flex-shrink: 0; }
.prov-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-family: var(--font-mono); color: var(--jg-text-muted); }
.prov-badge--github { color: var(--jg-text); }
.prov-badge--gitlab { color: var(--jg-orange, #fc6d26); }
.drawer-close { background: none; border: none; color: var(--jg-text-faint); cursor: pointer; padding: 4px; }
.drawer-close:hover { color: var(--jg-text); }
.drawer-loading, .drawer-error { padding: 24px; font-size: 12px; color: var(--jg-text-muted); display: flex; align-items: center; gap: 8px; }
.drawer-error { color: var(--jg-red); }
.drawer-body { flex: 1; overflow-y: auto; padding: 16px; }
.issue-title-row { display: flex; align-items: flex-start; gap: 8px; }
.issue-title { font-size: 16px; font-weight: 600; color: var(--jg-text); line-height: 1.4; margin: 0; }
.state-dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
.state-dot--open { background: var(--jg-green); }
.state-dot--closed { background: var(--jg-red); }
.issue-meta { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.meta-dim { font-size: 11px; color: var(--jg-text-faint); }
.badge { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; padding: 1px 6px; }
.badge--open { background: color-mix(in oklch, var(--jg-green) 18%, transparent); color: var(--jg-green); }
.badge--closed { background: color-mix(in oklch, var(--jg-red) 15%, transparent); color: var(--jg-red); }
.issue-labels { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
.label-chip { font-size: 10px; padding: 1px 7px; border: 1px solid var(--jg-border); border-radius: 10px; color: var(--jg-text-muted); }
.issue-assignees { font-size: 11px; color: var(--jg-text-faint); margin-bottom: 12px; }
.assignee { color: var(--jg-cyan); margin-left: 4px; }
.md-content { font-size: 12px; color: var(--jg-text); line-height: 1.7; }
.md-content :deep(h1), .md-content :deep(h2) { font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
.md-content :deep(p) { margin: 0 0 8px; }
.md-content :deep(ul), .md-content :deep(ol) { padding-left: 18px; margin: 0 0 8px; }
.md-content :deep(code) { font-family: var(--font-mono); font-size: 11px; background: var(--jg-hover); border: 1px solid var(--jg-border); padding: 1px 4px; }
.md-content :deep(pre) { background: var(--jg-hover); border: 1px solid var(--jg-border); padding: 10px; overflow-x: auto; }
.md-content :deep(a) { color: var(--jg-cyan); }
.comments { margin-top: 20px; border-top: 1px solid var(--jg-border); padding-top: 12px; }
.comments-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--jg-text-faint); margin-bottom: 8px; }
.comment { margin-bottom: 12px; }
.comment-head { font-size: 10px; color: var(--jg-text-faint); margin-bottom: 4px; }
.comment-body { padding-left: 8px; border-left: 2px solid var(--jg-border); }
.drawer-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--jg-border); flex-shrink: 0; }
.open-orig { font-size: 11px; color: var(--jg-text-muted); text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
.open-orig:hover { color: var(--jg-cyan); }
</style>
