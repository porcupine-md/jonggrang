import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useSecretsStore = defineStore('secrets', () => {
  const list = ref([]);
  const loading = ref(false);
  const error = ref(null);

  const byId = computed(() => Object.fromEntries(list.value.map(s => [s.id, s])));

  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      const res = await window.fetch('/api/secrets');
      if (!res.ok) throw new Error('Failed to fetch secrets');
      const data = await res.json();
      list.value = data.secrets || [];
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function fetchOne(id) {
    const res = await window.fetch(`/api/secrets/${id}`);
    if (!res.ok) throw new Error('Secret not found');
    return res.json();
  }

  async function create(data) {
    const res = await window.fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Create failed');
    }
    const secret = await res.json();
    list.value.push({
      id: secret.id,
      name: secret.name,
      description: secret.description,
      created_at: secret.created_at,
      var_count: Object.keys(secret.vars || {}).length,
    });
    return secret;
  }

  async function update(id, data) {
    const res = await window.fetch(`/api/secrets/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || 'Update failed');
    }
    const secret = await res.json();
    const idx = list.value.findIndex(s => s.id === id);
    if (idx >= 0) {
      list.value[idx] = {
        ...list.value[idx],
        name: secret.name,
        description: secret.description,
        var_count: Object.keys(secret.vars || {}).length,
      };
    }
    return secret;
  }

  async function remove(id) {
    const res = await window.fetch(`/api/secrets/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) throw new Error('Delete failed');
    list.value = list.value.filter(s => s.id !== id);
  }

  return { list, loading, error, byId, fetchAll, fetchOne, create, update, remove };
});
