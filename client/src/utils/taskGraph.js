const X_SPACING = 260;
const Y_SPACING = 140;
const X_OFFSET = 60;
const Y_OFFSET = 60;

function getValidBlockers(task, taskMap) {
  return (task.blocked_by || []).filter(blockerId => blockerId !== task.id && taskMap.has(blockerId));
}

function computeNodeLevels(tasks, dependentsById, blockersById) {
  const nodeLevels = new Map();
  const indegree = new Map();
  const queue = [];

  tasks.forEach(task => {
    const blockers = blockersById.get(task.id) || [];
    indegree.set(task.id, blockers.length);
    if (blockers.length === 0) {
      nodeLevels.set(task.id, 0);
      queue.push(task.id);
    }
  });

  while (queue.length > 0) {
    const taskId = queue.shift();
    const currentLevel = nodeLevels.get(taskId) ?? 0;
    const dependents = dependentsById.get(taskId) || [];

    dependents.forEach(childId => {
      const nextLevel = currentLevel + 1;
      if ((nodeLevels.get(childId) ?? -1) < nextLevel) {
        nodeLevels.set(childId, nextLevel);
      }

      const remaining = (indegree.get(childId) || 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) {
        queue.push(childId);
      }
    });
  }

  let fallbackLevel = Math.max(0, ...nodeLevels.values());
  tasks.forEach(task => {
    if (nodeLevels.has(task.id)) return;

    const blockerLevels = (blockersById.get(task.id) || [])
      .map(blockerId => nodeLevels.get(blockerId))
      .filter(level => level != null);

    if (blockerLevels.length > 0) {
      nodeLevels.set(task.id, Math.max(...blockerLevels) + 1);
      return;
    }

    fallbackLevel += 1;
    nodeLevels.set(task.id, fallbackLevel);
  });

  return nodeLevels;
}

export function buildTaskGraph(tasks = []) {
  const nodes = [];
  const edges = [];
  const levelColumns = new Map();
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const dependentsById = new Map();
  const blockersById = new Map();

  tasks.forEach(task => {
    const blockers = getValidBlockers(task, taskMap);
    blockersById.set(task.id, blockers);

    blockers.forEach(blockerId => {
      const dependents = dependentsById.get(blockerId) || [];
      dependents.push(task.id);
      dependentsById.set(blockerId, dependents);
    });
  });

  const nodeLevels = computeNodeLevels(tasks, dependentsById, blockersById);

  tasks.forEach(task => {
    const level = nodeLevels.get(task.id) ?? 0;
    const column = levelColumns.get(level) || 0;
    const x = (column * X_SPACING) + (level % 2 === 1 ? 100 : 0) + X_OFFSET;
    const y = (level * Y_SPACING) + Y_OFFSET;

    levelColumns.set(level, column + 1);
    nodes.push({
      id: task.id,
      position: { x, y },
      data: { ...task },
      type: 'taskNode',
    });

    (blockersById.get(task.id) || []).forEach(blockerId => {
      edges.push({
        id: `e-${blockerId}-${task.id}`,
        source: blockerId,
        target: task.id,
        animated: task.status === 'in_progress',
        style: {
          stroke: task.status === 'completed' ? 'var(--green)' : 'rgba(255,255,255,0.12)',
          strokeWidth: 2,
        },
      });
    });
  });

  return { nodes, edges };
}
