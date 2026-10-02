// Command registry. One line per command file; the router imports lazily.
export const COMMANDS = [
  'chat', 'init', 'projects', 'remote', 'telegram', 'sync', 'help', 'config', 'update',
  // crew (backend)
  'up', 'down', 'trust', 'dispatch', 'resend', 'task', 'done', 'block', 'wait', 'crew', 'board', 'plan',
  // memory + brain (helper)
  'memory', 'context', 'brain',
  // spec (dev)
  'spec',
  // ui (frontend)
  'doctor', 'dashboard',
];
