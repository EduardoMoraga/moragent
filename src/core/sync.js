import path from 'node:path';
import { dirs, TEMPLATES } from './paths.js';
import { readText, writeText, upsertBlock, copyDir, exists } from './fsx.js';
import { tr } from './i18n.js';

// Used only until src/crew/adapters.js exists; must mirror its instructionFiles/skillsDirs.
const FALLBACK = {
  claude: { label: 'Claude Code', instructionFiles: ['CLAUDE.md'], skillsDirs: ['.claude/skills'] },
  codex: { label: 'Codex', instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills'] },
  agy: { label: 'Antigravity', instructionFiles: ['GEMINI.md', 'AGENTS.md'], skillsDirs: ['.agents/skills'] },
  pi: { label: 'Pi', instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills', '.pi/skills'] },
  opencode: { label: 'OpenCode', instructionFiles: ['AGENTS.md'], skillsDirs: ['.agents/skills', '.opencode/skill'] },
  gemini: { label: 'Gemini CLI', instructionFiles: ['GEMINI.md'], skillsDirs: ['.agents/skills'] },
};

async function adapterInfo(id) {
  try {
    const mod = await import(new URL('../crew/adapters.js', import.meta.url).href);
    const a = mod.ADAPTERS?.[id];
    if (a) return a;
  } catch { /* backend module not built yet */ }
  return FALLBACK[id] || FALLBACK.codex;
}

function crewTable(cfg, labels) {
  return Object.entries(cfg.crew)
    .map(([role, m]) => `| \`${role}\` | ${labels[m.cli] || m.cli} | ${typeof m.mission === 'string' ? m.mission : tr(m.mission)} |`)
    .join('\n');
}

// Regenerate managed instruction blocks and skill copies for every CLI in the crew.
// Returns { files: [written paths], skills: [written paths] }. With dryRun nothing is written.
export async function syncProject(root, cfg, { dryRun = false } = {}) {
  const d = dirs(root);
  const clis = [...new Set(Object.values(cfg.crew).map((m) => m.cli))];
  const infos = Object.fromEntries(await Promise.all(clis.map(async (id) => [id, await adapterInfo(id)])));
  const labels = Object.fromEntries(clis.map((id) => [id, infos[id].label || id]));

  const lang = cfg.lang === 'en' ? 'en' : 'es';
  const tpl = readText(path.join(TEMPLATES, 'instructions', `agents.${lang}.md`));
  const body = tpl.replaceAll('{{project}}', cfg.project).replaceAll('{{crew_table}}', crewTable(cfg, labels));

  // AGENTS.md is canonical; CLAUDE.md and GEMINI.md import it when any crew CLI reads them.
  const wanted = new Set(['AGENTS.md']);
  for (const id of clis) for (const f of infos[id].instructionFiles || []) wanted.add(f);

  const files = [];
  for (const name of wanted) {
    const p = path.join(root, name);
    const before = readText(p);
    let next;
    if (name === 'AGENTS.md') next = upsertBlock(before, 'core', body);
    else {
      const pointer = lang === 'es'
        ? '@AGENTS.md\n\n> Las instrucciones canónicas del proyecto están en AGENTS.md (gestionado por MORAGENT).'
        : '@AGENTS.md\n\n> Canonical project instructions live in AGENTS.md (managed by MORAGENT).';
      next = upsertBlock(before, 'pointer', pointer);
    }
    if (next !== before) { files.push(p); if (!dryRun) writeText(p, next); }
  }

  // Skills: bundled templates first, project skills override them.
  const skillDirs = new Set();
  for (const id of clis) for (const s of infos[id].skillsDirs || []) skillDirs.add(s);
  const skills = [];
  for (const rel of skillDirs) {
    const dst = path.join(root, rel);
    for (const src of [path.join(TEMPLATES, 'skills'), d.skills]) {
      if (!exists(src)) continue;
      if (dryRun) skills.push(`${src} → ${dst}`);
      else skills.push(...copyDir(src, dst));
    }
  }
  return { files, skills, clis };
}
