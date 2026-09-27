import { loadConfig } from './config.js';

// Keep the Obsidian Map of Content current after anything that changes the board or memory.
// Only when a vault is linked; never fails the calling command.
export async function refreshBrain(root) {
  try {
    const cfg = loadConfig(root);
    if (!cfg.brain?.vault) return false;
    const brain = await import(new URL('../brain/obsidian.js', import.meta.url).href);
    if (typeof brain.sync === 'function') await brain.sync(root);
    else if (typeof brain.buildHome === 'function') await brain.buildHome(root);
    return true;
  } catch {
    return false;
  }
}
