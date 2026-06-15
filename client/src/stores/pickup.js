import { defineStore } from 'pinia';
import { ref } from 'vue';

// Cross-navigation transport for "Pickup → Plan" (feature #55). Holds the
// pre-fill payload so PlanView can open the New-Plan form already populated,
// without putting a large issue body in the URL. For the New-Project flow the
// intent is parked in `pending` until the import finishes and a project_id is
// known, at which point the import view finalizes the pickup.
export const usePickupStore = defineStore('pickup', () => {
  const prefill = ref(null);  // { projectId, description, source }
  const pending = ref(null);  // { provider, repo, number, title } awaiting a new project

  function setPrefill(p) { prefill.value = p; }

  // Return + clear the prefill iff it targets this project.
  function consumePrefill(projectId) {
    const p = prefill.value;
    if (p && p.projectId === projectId) { prefill.value = null; return p; }
    return null;
  }

  function setPending(p) { pending.value = p; }
  function takePending() { const p = pending.value; pending.value = null; return p; }

  return { prefill, pending, setPrefill, consumePrefill, setPending, takePending };
});
