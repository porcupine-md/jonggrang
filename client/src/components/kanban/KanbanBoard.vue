<template>
  <div class="kanban-root">
    <KanbanHeader :projectId="projectId" />
    <div class="kanban-body">
      <div v-if="!tasks.tasks.length && state === 'idle'" class="kanban-empty">
        <div>No tasks yet. Generate a plan first.</div>
        <RouterLink :to="`/projects/${projectId}/plan`" class="btn btn--secondary" style="margin-top:12px">Go to Plan</RouterLink>
      </div>
      <template v-else>
        <KanbanColumn title="To Do" :tasks="tasks.columns.todo" color="#6b7280" @open-task="openTask" />
        <KanbanColumn title="In Progress" :tasks="tasks.columns.in_progress" color="#f59e0b" @open-task="openTask" />
        <KanbanColumn title="Blocked" :tasks="tasks.columns.blocked" color="#ef4444" @open-task="openTask" />
        <KanbanColumn title="Done" :tasks="tasks.columns.done" color="#10b981" @open-task="openTask" />
      </template>
    </div>

    <TaskDetailDrawer
      v-if="selectedTask"
      :task="selectedTask"
      :projectId="projectId"
      @close="selectedTask = null"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useTasksStore } from '../../stores/tasks.js';
import { useProjectsStore } from '../../stores/projects.js';
import KanbanHeader from './KanbanHeader.vue';
import KanbanColumn from './KanbanColumn.vue';
import TaskDetailDrawer from './TaskDetailDrawer.vue';

const route = useRoute();
const projectId = computed(() => route.params.id);
const tasks = useTasksStore();
const projects = useProjectsStore();
const project = computed(() => projects.byId[projectId.value]);
const state = computed(() => project.value?.derived_state?.state || 'idle');
const selectedTask = ref(null);

function openTask(task) { selectedTask.value = task; }

onMounted(() => {
  tasks.fetchTasks(projectId.value);
});
</script>

<style scoped>
.kanban-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.kanban-body { display: flex; flex: 1; gap: 12px; padding: 16px; overflow: hidden; }
.kanban-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; color: #6b7280; text-align: center; }
</style>
