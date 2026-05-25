export const PHASES_UI = {
  1:  { name: 'Setup', role: null },
  2:  { name: 'Triage', role: null },
  3:  { name: 'Discovery', role: null },
  4:  { name: 'Skill Map', role: null },
  5:  { name: 'Complexity', role: 'lead' },
  6:  { name: 'Brainstorm', role: 'lead' },
  7:  { name: 'Architect', role: 'lead' },
  8:  { name: 'Implement', role: 'developer' },
  9:  { name: 'Simplify', role: 'developer' },
  10: { name: 'Design Check', role: 'reviewer' },
  11: { name: 'Compliance', role: 'reviewer' },
  12: { name: 'Quality', role: 'reviewer' },
  13: { name: 'Test Plan', role: 'test-lead' },
  14: { name: 'Testing', role: 'tester' },
  15: { name: 'Coverage', role: 'tester' },
  16: { name: 'Test Quality', role: 'reviewer' },
  17: { name: 'Complete', role: 'lead' },
};

export const ROLE_COLORS = {
  lead: '#8b5cf6',
  developer: '#3b82f6',
  reviewer: '#f59e0b',
  'test-lead': '#06b6d4',
  tester: '#10b981',
};

export const WORK_TYPE_COLORS = {
  BUGFIX: '#ef4444',
  SMALL: '#10b981',
  MEDIUM: '#f59e0b',
  LARGE: '#8b5cf6',
};

export const TASK_COLUMNS = [
  { key: 'pending', label: 'TODO', include: ['pending'] },
  { key: 'in_progress', label: 'IN PROGRESS', include: ['in_progress', 'waiting', 'review'] },
  { key: 'completed', label: 'DONE', include: ['completed'] },
  { key: 'blocked', label: 'BLOCKED', include: ['blocked'] },
];

export const phaseNumbers = Object.keys(PHASES_UI).map(Number);

const STATUS_COLORS = {
  completed: 'var(--green)',
  in_progress: 'var(--blue)',
  waiting: 'var(--yellow)',
  review: 'var(--yellow)',
  blocked: 'var(--red)',
};

const STATUS_LABELS = {
  pending: 'Ready',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  review: 'Review',
  completed: 'Done',
  blocked: 'Blocked',
};

export function chunkIntoRows(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

export function getStatusColor(status) {
  return STATUS_COLORS[status] || 'var(--text-muted)';
}

export function getStatusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function classifyWorkType(description) {
  const normalized = description.trim().toLowerCase();
  if (!normalized) return null;

  const isBugfix = /\b(fix|bug|broken|crash|typo|hotfix|regression)\b/.test(normalized)
    || /\berror\b(?!\s*(message|handling|response|code|log|output|format))/.test(normalized);
  if (isBugfix) return 'BUGFIX';

  const isLarge = /\b(subsystem|architecture|refactor|migrate|overhaul|redesign|platform|infrastructure|framework)\b/.test(normalized)
    || /\b(authentication|authorization|auth system|checkout|billing|subscription)\b/.test(normalized)
    || /\bpayment\b.{0,40}\b(flow|system|integration|gateway|processor|webhook)\b/.test(normalized)
    || (normalized.match(/,/g) || []).length >= 3;
  if (isLarge) return 'LARGE';

  const isMedium = /\b(implement|build|create|develop|setup|integrate)\b.{0,80}\b(with|including|plus)\b/.test(normalized)
    || /\b(module|service|flow|handler|integration|pipeline|workflow)\b/.test(normalized);
  if (isMedium) return 'MEDIUM';

  return 'SMALL';
}

export function getWorkTypeHint(workType) {
  if (!workType) return '';
  if (workType === 'SMALL' || workType === 'BUGFIX') {
    return 'Work loop only — no quality gates';
  }
  if (workType === 'MEDIUM') {
    return 'Work loop + reviewer quality pass';
  }
  return 'Work loop + full quality gates (reviewer, tests, coverage)';
}

export function getWorkTypeStyle(workType) {
  const color = WORK_TYPE_COLORS[workType];
  return color ? { color, background: `${color}18` } : {};
}
