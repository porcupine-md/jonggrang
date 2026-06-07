import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', component: () => import('../views/ProjectListView.vue') },
  { path: '/import', component: () => import('../views/ImportFlowView.vue') },
  {
    path: '/projects/:id',
    component: () => import('../views/ProjectDetailView.vue'),
    children: [
      { path: '', redirect: to => ({ path: `/projects/${to.params.id}/plan` }) },
      // Project scope
      { path: 'plan', component: () => import('../components/plan/PlanView.vue') },
      { path: 'changelog', component: () => import('../views/ChangelogView.vue') },
      { path: 'agent',    component: () => import('../views/AgentView.vue') },
      { path: 'terminal', component: () => import('../views/TerminalView.vue') },
      { path: 'settings', component: () => import('../views/ProjectSettingsView.vue') },
      // Work Mode — everything scoped to one plan (featureId)
      { path: 'plans/:featureId', redirect: to => ({ path: `/projects/${to.params.id}/plans/${to.params.featureId}/pipeline` }) },
      { path: 'plans/:featureId/pipeline', component: () => import('../views/PipelineView.vue') },
      { path: 'plans/:featureId/tasks',    component: () => import('../components/kanban/KanbanBoard.vue') },
      { path: 'plans/:featureId/logs',     component: () => import('../views/PlanLogsView.vue') },
      { path: 'plans/:featureId/changes',  component: () => import('../views/ChangesView.vue') },
      { path: 'plans/:featureId/agent',    component: () => import('../views/AgentView.vue') },
      { path: 'plans/:featureId/terminal', component: () => import('../views/TerminalView.vue') },
      // Legacy project-level routes — now plan-scoped, send back to the plan list
      { path: 'pipeline',    redirect: to => ({ path: `/projects/${to.params.id}/plan` }) },
      { path: 'tasks',       redirect: to => ({ path: `/projects/${to.params.id}/plan` }) },
      { path: 'orchestrate', redirect: to => ({ path: `/projects/${to.params.id}/plan` }) },
      { path: 'logs',        redirect: to => ({ path: `/projects/${to.params.id}/plan` }) },
    ],
  },
  { path: '/settings', component: () => import('../views/SettingsView.vue') },
  { path: '/secrets',  component: () => import('../views/SecretsView.vue') },
  // Legacy single-project route — keep old UI accessible
  { path: '/legacy', component: () => import('../views/LegacyView.vue') },
];

export default createRouter({ history: createWebHistory(), routes });
