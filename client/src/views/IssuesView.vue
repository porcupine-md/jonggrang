<template>
  <div class="page">
    <div class="page-header">
      <div>
        <div class="page-title">Issues</div>
        <div class="page-subtitle">Browse GitHub &amp; GitLab issues and pick them up as plans</div>
      </div>
      <Button severity="secondary" :disabled="store.loading || !hasSources" @click="reload">
        <i :class="store.loading ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'" /> Refresh
      </Button>
    </div>

    <!-- No token configured at all -->
    <div v-if="!anyConnected" class="empty-card">
      <i class="pi pi-github empty-icon" />
      <div class="empty-title">No git host connected</div>
      <div class="empty-desc">Add a GitHub or GitLab personal access token to list issues.</div>
      <RouterLink to="/settings"><Button><i class="pi pi-cog" /> Open Settings</Button></RouterLink>
    </div>

    <template v-else>
      <!-- Provider + filters bar -->
      <div class="filters">
        <div class="prov-tabs">
          <button
            v-for="p in providerTabs" :key="p.value"
            class="prov-tab" :class="{ 'prov-tab--active': provider === p.value }"
            @click="provider = p.value"
          ><ProviderIcon v-if="p.value !== 'all'" :provider="p.value" :size="13" /><i v-else :class="p.icon" /> {{ p.label }}</button>
        </div>

        <Select
          v-model="repo"
          :options="repoOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="All repos"
          filter
          class="filter-select"
          :disabled="provider === 'all'"
        />

        <Select v-model="stateFilter" :options="STATES" optionLabel="label" optionValue="value" class="filter-select filter-state" />

        <label class="me-toggle">
          <input type="checkbox" v-model="assignedToMe" /> Assigned to me
        </label>

        <div class="search-box">
          <i class="pi pi-search" />
          <input v-model="search" placeholder="Search title / body…" @keydown.enter="reload" />
        </div>
      </div>

      <!-- No repos configured for this provider -->
      <div v-if="!hasSources" class="hint-row">
        No {{ provider }} repos selected. Add some in
        <RouterLink to="/settings" class="inline-link">Settings → Issue sources</RouterLink>.
      </div>

      <!-- Error -->
      <div v-else-if="store.error" class="error-row"><i class="pi pi-exclamation-triangle" /> {{ store.error }}</div>

      <!-- Loading -->
      <div v-else-if="store.loading" class="hint-row"><i class="pi pi-spin pi-spinner" /> Loading issues…</div>

      <!-- Empty -->
      <div v-else-if="!store.issues.length" class="hint-row">No issues match the current filters.</div>

      <!-- Issue list + pagination -->
      <template v-else>
      <div class="issue-list">
        <div v-for="it in store.issues" :key="`${it.repo}#${it.number}`" class="issue-row" @click="openDetail(it)">
          <span class="state-dot" :class="`state-dot--${it.state}`" />
          <span class="prov-tag" :class="`prov-tag--${it.provider}`">
            <ProviderIcon :provider="it.provider" :size="11" />{{ it.provider === 'gitlab' ? 'GitLab' : 'GitHub' }}
          </span>
          <div class="issue-main">
            <div class="issue-head">
              <span class="issue-title">{{ it.title }}</span>
              <span class="issue-ref">{{ it.repo }}#{{ it.number }}</span>
            </div>
            <div class="issue-sub">
              <span v-for="l in it.labels.slice(0, 4)" :key="l" class="label-chip">{{ l }}</span>
              <span v-if="it.assignees.length" class="sub-dim">@{{ it.assignees[0] }}</span>
              <span v-if="it.comments_count" class="sub-dim"><i class="pi pi-comment" /> {{ it.comments_count }}</span>
              <span class="sub-preview">{{ it.body_preview }}</span>
            </div>
          </div>
          <div class="issue-actions">
            <a :href="it.url" target="_blank" rel="noopener" class="icon-link" title="Open original" @click.stop>
              <i class="pi pi-external-link" />
            </a>
            <Button size="small" @click.stop="openPickup(it)"><i class="pi pi-arrow-right" /> Pickup</Button>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="store.pagination.page > 1 || store.pagination.has_more" class="pager">
        <Button size="small" severity="secondary" :disabled="store.pagination.page <= 1 || store.loading" @click="goPage(store.pagination.page - 1)">
          <i class="pi pi-chevron-left" /> Prev
        </Button>
        <span class="pager-info">
          Page {{ store.pagination.page }}<span v-if="store.pagination.total != null"> · {{ store.pagination.total }} issues</span>
        </span>
        <Button size="small" severity="secondary" :disabled="!store.pagination.has_more || store.loading" @click="goPage(store.pagination.page + 1)">
          Next <i class="pi pi-chevron-right" />
        </Button>
      </div>
      </template>
    </template>

    <IssueDetailDrawer v-if="drawerIssue" :basic="drawerIssue" @close="drawerIssue = null" @pickup="openPickup" />
    <PickupModal v-if="pickupSource" :visible="!!pickupSource" :source="pickupSource" @close="pickupSource = null" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useIssuesStore } from '../stores/issues.js';
import IssueDetailDrawer from '../components/issues/IssueDetailDrawer.vue';
import PickupModal from '../components/issues/PickupModal.vue';
import ProviderIcon from '../components/ProviderIcon.vue';

const store = useIssuesStore();

const STATES = [
  { label: 'Open', value: 'open' },
  { label: 'Closed', value: 'closed' },
  { label: 'All', value: 'all' },
];

const ALL_REPOS = '__all__'; // sentinel: aggregate across all configured repos

const provider = ref('all'); // 'all' (both providers) | 'github' | 'gitlab'
const repo = ref(ALL_REPOS);
const stateFilter = ref('open');
const assignedToMe = ref(false);
const search = ref('');
const page = ref(1);
const drawerIssue = ref(null);
const pickupSource = ref(null);
let ready = false; // gates watchers until the initial load is set up

const availableProviders = computed(() => {
  const out = [];
  if (store.connections.has_gh) out.push({ label: 'GitHub', value: 'github', icon: 'pi pi-github' });
  if (store.connections.has_gitlab) out.push({ label: 'GitLab', value: 'gitlab', icon: 'pi pi-gitlab' });
  return out;
});
const anyConnected = computed(() => availableProviders.value.length > 0);
// Provider tabs: "All" (both providers fetched together) first, then each connected one.
const providerTabs = computed(() => [{ label: 'All', value: 'all', icon: 'pi pi-list' }, ...availableProviders.value]);
const hasSources = computed(() => {
  const s = store.connections.sources || {};
  if (provider.value === 'all') return (s.github?.length || 0) + (s.gitlab?.length || 0) > 0;
  return (s[provider.value] || []).length > 0;
});
const repoOptions = computed(() => {
  // A specific repo only makes sense within one provider; in "All" mode the
  // repo filter is disabled (pick a provider tab to narrow to a repo).
  if (provider.value === 'all') return [{ label: 'All repos', value: ALL_REPOS }];
  const repos = store.connections.sources?.[provider.value] || [];
  return [{ label: 'All repos', value: ALL_REPOS }, ...repos.map(r => ({ label: r, value: r }))];
});

function reload() {
  if (!hasSources.value) { store.issues = []; return; }
  store.fetchIssues({
    provider: provider.value,
    repo: repo.value === ALL_REPOS ? '' : repo.value,
    state: stateFilter.value,
    assignee: assignedToMe.value ? '@me' : '',
    q: search.value.trim(),
    page: page.value,
  });
}

function applyFilters() { page.value = 1; reload(); }
function goPage(p) { if (p < 1) return; page.value = p; reload(); }

function openDetail(it) { drawerIssue.value = { provider: it.provider, repo: it.repo, number: it.number, url: it.url }; }
function openPickup(it) {
  drawerIssue.value = null;
  pickupSource.value = { provider: it.provider, repo: it.repo, number: it.number, title: it.title };
}

watch(provider, () => { if (!ready) return; repo.value = ALL_REPOS; applyFilters(); });
watch([repo, stateFilter, assignedToMe], () => { if (ready) applyFilters(); });

onMounted(async () => {
  await store.fetchConnections();
  provider.value = 'all'; // fetch GitHub + GitLab together by default
  repo.value = ALL_REPOS;
  page.value = 1;
  ready = true;
  reload();
});
</script>

<style scoped>
.empty-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 60px 20px; text-align: center; }
.empty-icon { font-size: 36px; color: var(--jg-text-faint); }
.empty-title { font-size: 15px; font-weight: 600; color: var(--jg-text); }
.empty-desc { font-size: 12px; color: var(--jg-text-muted); margin-bottom: 6px; }

.filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.prov-tabs { display: flex; border: 1px solid var(--jg-border); border-radius: var(--radius); overflow: hidden; }
.prov-tab { background: var(--jg-card); border: none; color: var(--jg-text-muted); font-size: 12px; padding: 6px 14px; cursor: pointer; display: flex; align-items: center; gap: 6px; border-right: 1px solid var(--jg-border); }
.prov-tab:last-child { border-right: none; }
.prov-tab--active { background: color-mix(in oklch, var(--jg-green) 14%, transparent); color: var(--jg-green); }
.filter-select { min-width: 200px; font-size: 12px; }
.filter-state { min-width: 110px; }
.me-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--jg-text-muted); cursor: pointer; }
.me-toggle input { accent-color: var(--jg-green); }
.search-box { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 180px; background: var(--jg-card); border: 1px solid var(--jg-border); border-radius: var(--radius); padding: 5px 10px; }
.search-box i { color: var(--jg-text-faint); font-size: 12px; }
.search-box input { flex: 1; background: none; border: none; outline: none; color: var(--jg-text); font-size: 12px; font-family: var(--font-mono); }

.hint-row { font-size: 12px; color: var(--jg-text-faint); padding: 16px 4px; display: flex; align-items: center; gap: 8px; }
.error-row { font-size: 12px; color: var(--jg-red); padding: 16px 4px; display: flex; align-items: center; gap: 8px; }
.inline-link, .inline-link:visited { color: var(--jg-cyan); }

.issue-list { display: flex; flex-direction: column; border: 1px solid var(--jg-border); border-radius: var(--radius); overflow: hidden; }
.issue-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--jg-border); cursor: pointer; transition: background 0.12s; }
.issue-row:last-child { border-bottom: none; }
.issue-row:hover { background: var(--jg-hover); }
.state-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.state-dot--open { background: var(--jg-green); }
.state-dot--closed { background: var(--jg-red); }
.issue-main { flex: 1; min-width: 0; }
.issue-head { display: flex; align-items: baseline; gap: 8px; }
.issue-title { font-size: 13px; color: var(--jg-text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-ref { font-size: 11px; color: var(--jg-text-faint); font-family: var(--font-mono); flex-shrink: 0; }
.prov-tag { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 4px; border: 1px solid transparent; }
.prov-tag .pi { font-size: 10px; }
.prov-tag--github { color: #d2a8ff; border-color: color-mix(in oklch, #d2a8ff 38%, transparent); background: color-mix(in oklch, #d2a8ff 12%, transparent); }
.prov-tag--gitlab { color: var(--jg-orange, #fc6d26); border-color: color-mix(in oklch, var(--jg-orange, #fc6d26) 40%, transparent); background: color-mix(in oklch, var(--jg-orange, #fc6d26) 12%, transparent); }
.issue-sub { display: flex; align-items: center; gap: 8px; margin-top: 3px; overflow: hidden; }
.label-chip { font-size: 9px; padding: 1px 6px; border: 1px solid var(--jg-border); border-radius: 10px; color: var(--jg-text-muted); white-space: nowrap; flex-shrink: 0; }
.sub-dim { font-size: 10px; color: var(--jg-text-faint); white-space: nowrap; flex-shrink: 0; }
.sub-preview { font-size: 11px; color: var(--jg-text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.icon-link { color: var(--jg-text-faint); }
.icon-link:hover { color: var(--jg-cyan); }

.pager { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 14px; }
.pager-info { font-size: 11px; color: var(--jg-text-muted); font-family: var(--font-mono); }
</style>
