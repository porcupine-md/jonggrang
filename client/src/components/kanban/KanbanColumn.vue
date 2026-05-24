<template>
  <div class="kanban-column">
    <div class="column-header" :style="{ borderTopColor: color }">
      <span class="col-title">{{ title }}</span>
      <span class="col-count">{{ tasks.length }}</span>
    </div>
    <div class="column-body">
      <TransitionGroup tag="div" name="card" class="card-list">
        <TaskCard
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          @click="$emit('open-task', task)"
        />
      </TransitionGroup>
      <div v-if="!tasks.length" class="col-empty">empty</div>
    </div>
  </div>
</template>

<script setup>
import TaskCard from './TaskCard.vue';

defineProps({ title: String, tasks: Array, color: String });
defineEmits(['open-task']);
</script>

<style scoped>
.kanban-column {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  background: #0d0e14; border: 1px solid #1e1f2a; border-radius: 8px; overflow: hidden;
}
.column-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-top: 2px solid transparent; flex-shrink: 0;
  border-bottom: 1px solid #1e1f2a;
}
.col-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; }
.col-count { font-size: 11px; background: #1e1f2a; color: #6b7280; padding: 1px 6px; border-radius: 10px; }
.column-body { flex: 1; overflow-y: auto; padding: 8px; }
.card-list { display: flex; flex-direction: column; gap: 6px; position: relative; }
.col-empty { font-size: 11px; color: #2d2f3e; text-align: center; padding: 20px 0; }

/* TransitionGroup animations */
.card-move, .card-enter-active, .card-leave-active { transition: all 350ms cubic-bezier(0.4,0,0.2,1); }
.card-enter-from { opacity: 0; transform: translateY(-8px); }
.card-leave-to   { opacity: 0; transform: translateX(-8px); }
.card-leave-active { position: absolute; width: calc(100% - 16px); }
</style>
