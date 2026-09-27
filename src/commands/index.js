// Command registry. One line per command file; the router imports lazily.
export const COMMANDS = [
  'init', 'sync', 'help', 'config',
  // crew (backend)
  'up', 'down', 'trust', 'dispatch', 'resend', 'task', 'done', 'block', 'wait', 'crew', 'board', 'plan',
  // memory + brain (helper)
  'memory', 'context', 'brain',
  // spec (dev)
  'spec',
  // ui (frontend)
  'doctor', 'dashboard',
];
