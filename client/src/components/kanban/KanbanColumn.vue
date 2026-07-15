<template>
  <div class="kanban-column" :class="`col--${accent}`">
    <div class="column-header">
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
      <div v-if="!tasks.length" class="col-empty">—</div>
    </div>
  </div>
</template>

<script setup>
import TaskCard from './TaskCard.vue';

defineProps({ title: String, tasks: Array, accent: String });
defineEmits(['open-task']);
</script>

<style scoped>
.kanban-column {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  background: var(--jg-card); border: 1px solid var(--jg-border);
  border-radius: var(--radius); overflow: hidden;
}
.column-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-top: 2px solid var(--jg-border); flex-shrink: 0;
  border-bottom: 1px solid var(--jg-border);
}
.col--muted .column-header   { border-top-color: var(--jg-text-faint); }
.col--orange .column-header  { border-top-color: var(--jg-orange); }
.col--red .column-header     { border-top-color: var(--jg-red); }
.col--green .column-header   { border-top-color: var(--jg-green); }

.col-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--jg-text-muted); }
.col--orange .col-title { color: var(--jg-orange); }
.col--red .col-title    { color: var(--jg-red); }
.col--green .col-title  { color: var(--jg-green); }

.col-count { font-size: 9px; background: var(--jg-hover); color: var(--jg-text-faint); padding: 1px 5px; border-radius: 0px; letter-spacing: 0.04em; }
.column-body { flex: 1; overflow-y: auto; padding: 8px; }
.card-list { display: flex; flex-direction: column; gap: 6px; position: relative; }
.col-empty { font-size: 11px; color: var(--jg-text-faint); text-align: center; padding: 20px 0; }

/* Animate only transform + opacity — never `all`, which also transitions
   layout properties and made moving/entering cards pile up during live updates. */
.card-move, .card-enter-active, .card-leave-active { transition: transform 350ms cubic-bezier(0.4,0,0.2,1), opacity 350ms cubic-bezier(0.4,0,0.2,1); }
.card-enter-from { opacity: 0; transform: translateY(-8px); }
.card-leave-to   { opacity: 0; transform: translateX(-8px); }
/* Take leaving cards out of flow so siblings can FLIP-move smoothly. */
.card-leave-active { position: absolute; width: calc(100% - 16px); }
</style>
