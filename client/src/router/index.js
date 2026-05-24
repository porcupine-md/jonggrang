import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', component: () => import('../views/ProjectListView.vue') },
  { path: '/import', component: () => import('../views/ImportFlowView.vue') },
  {
    path: '/projects/:id',
    component: () => import('../views/ProjectDetailView.vue'),
    children: [
      { path: '', redirect: to => ({ path: `/projects/${to.params.id}/plan` }) },
      { path: 'plan', component: () => import('../components/plan/PlanView.vue') },
      { path: 'pipeline', component: () => import('../views/PipelineView.vue') },
      { path: 'tasks', component: () => import('../components/kanban/KanbanBoard.vue') },
      { path: 'logs', component: () => import('../components/log/LogStream.vue') },
    ],
  },
  { path: '/settings', component: () => import('../views/SettingsView.vue') },
  // Legacy single-project route — keep old UI accessible
  { path: '/legacy', component: () => import('../views/LegacyView.vue') },
];

export default createRouter({ history: createWebHistory(), routes });
