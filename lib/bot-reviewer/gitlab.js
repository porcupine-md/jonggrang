'use strict';

class GitLabClient {
  constructor(token, baseUrl = 'https://gitlab.com') {
    this.token = token;
    this.api = `${baseUrl.replace(/\/$/, '')}/api/v4`;
  }

  async request(path, options = {}) {
    const url = `${this.api}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`GitLab ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  }

  getCurrentUser() {
    return this.request('/user');
  }

  searchProjects(query) {
    return this.request(`/projects?search=${encodeURIComponent(query)}&per_page=20&membership=true&order_by=last_activity_at`);
  }

  getOpenMRs(projectId) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests?state=opened&per_page=50&order_by=updated_at`);
  }

  getMRChanges(projectId, mrIid) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`);
  }

  getMRVersions(projectId, mrIid) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/versions`);
  }

  postMRNote(projectId, mrIid, body) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  postMRDiscussion(projectId, mrIid, body, position) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`, {
      method: 'POST',
      body: JSON.stringify(position ? { body, position } : { body }),
    });
  }
}

module.exports = { GitLabClient };
