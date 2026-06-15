import { defineStore } from 'pinia';
import { ref } from 'vue';

// Issues store (feature #55) — browse GitHub/GitLab issues and pick them up as
// plans. All calls hit /api/issues/* which reuses the stored PATs server-side.
export const useIssuesStore = defineStore('issues', () => {
  const connections = ref({ has_gh: false, has_gitlab: false, sources: { github: [], gitlab: [] } });
  const issues = ref([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchConnections() {
    try {
      const r = await fetch('/api/issues/connections');
      if (r.ok) connections.value = await r.json();
    } catch {}
  }

  async function searchRepos(provider, q = '') {
    const r = await fetch(`/api/issues/repos?provider=${provider}&q=${encodeURIComponent(q)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed to list repos');
    return d.repos || [];
  }

  async function saveSources(sources) {
    const r = await fetch('/api/issues/sources', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sources),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed to save sources');
    connections.value.sources = d.sources;
    return d.sources;
  }

  async function fetchIssues({ provider, repo, state, label, assignee, q, page } = {}) {
    if (!provider || !repo) { issues.value = []; return; }
    loading.value = true; error.value = '';
    try {
      const params = new URLSearchParams({ provider, repo });
      if (state) params.set('state', state);
      if (label) params.set('label', label);
      if (assignee) params.set('assignee', assignee);
      if (q) params.set('q', q);
      if (page) params.set('page', String(page));
      const r = await fetch(`/api/issues?${params.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Failed to load issues');
      issues.value = d.issues || [];
    } catch (e) {
      error.value = e.message; issues.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function fetchDetail(provider, repo, number) {
    const params = new URLSearchParams({ provider, repo, number: String(number) });
    const r = await fetch(`/api/issues/detail?${params.toString()}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Failed to load issue');
    return d.issue;
  }

  // Returns { pickup_id, project_id, description, source }
  async function pickup(provider, repo, number, projectId) {
    const body = { provider, repo, number };
    if (projectId) body.project_id = projectId;
    const r = await fetch('/api/issues/pickup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Pickup failed');
    return d;
  }

  return {
    connections, issues, loading, error,
    fetchConnections, searchRepos, saveSources, fetchIssues, fetchDetail, pickup,
  };
});
