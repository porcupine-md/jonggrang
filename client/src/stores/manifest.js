import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

const PHASES = [
  { num: 1,  name: 'Setup',        role: 'Lead' },
  { num: 2,  name: 'Triage',       role: 'Lead' },
  { num: 3,  name: 'Discovery',    role: 'Lead' },
  { num: 4,  name: 'SkillMap',     role: 'Lead' },
  { num: 5,  name: 'Complexity',   role: 'Lead' },
  { num: 6,  name: 'Brainstorm',   role: 'Lead' },
  { num: 7,  name: 'Architect',    role: 'Lead' },
  { num: 8,  name: 'Implement',    role: 'Developer' },
  { num: 9,  name: 'DesignVerify', role: 'Reviewer' },
  { num: 10, name: 'Compliance',   role: 'Reviewer' },
  { num: 11, name: 'Quality',      role: 'Reviewer' },
  { num: 12, name: 'TestPlan',     role: 'TestLead' },
  { num: 13, name: 'Test',         role: 'Tester' },
  { num: 14, name: 'Coverage',     role: 'Tester' },
  { num: 15, name: 'TestQuality',  role: 'Reviewer' },
  { num: 16, name: 'Complete',     role: 'Lead' },
];

export const useManifestStore = defineStore('manifest', () => {
  const data = ref(null);
  const projectId = ref(null);

  const phases = computed(() => {
    if (!data.value) return [];
    const active = new Set(data.value.active_phases || []);
    const phaseStates = data.value.phases || {};
    const current = data.value.current_phase;

    return PHASES.map(p => {
      if (!active.has(p.num)) return { ...p, status: 'skipped' };
      const s = phaseStates[String(p.num)];
      if (s?.status === 'completed') return { ...p, status: 'completed', completed_at: s.completed_at };
      if (p.num === current) return { ...p, status: 'in_progress', started_at: s?.started_at };
      return { ...p, status: 'pending' };
    });
  });

  async function fetch(pid) {
    projectId.value = pid;
    try {
      const res = await window.fetch(`/api/projects/${pid}/manifest`);
      if (res.ok) data.value = await res.json();
      else data.value = null;
    } catch {
      data.value = null;
    }
  }

  function update(manifest) {
    data.value = manifest;
  }

  function clear() {
    data.value = null;
    projectId.value = null;
  }

  return { data, projectId, phases, fetch, update, clear };
});
