import fs from 'node:fs';
import path from 'node:path';
import { findRoot, dirs, TEMPLATES } from '../core/paths.js';
import { loadConfig, PRESETS, CLI_IDS } from '../core/config.js';
import { run, which } from '../core/exec.js';
import { exists, readText } from '../core/fsx.js';
import { syncProject } from '../core/sync.js';
import { t } from '../core/i18n.js';
import { out, c, json } from '../core/log.js';
import { cliCatalog, loadAdapters, detectMux, MUXES } from '../ui/clis.js';

// A check: { id, group, status: 'ok'|'warn'|'fail'|'skip', label, detail, fix }
const check = (group, id, status, label, detail = '', fix = '') => ({ group, id, status, label, detail, fix });

export function parseVersion(s) {
  const m = String(s || '').match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return m ? m[0] : null;
}

function nodeCheck() {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  return major >= 18
    ? check('system', 'node', 'ok', 'Node.js', `v${v}`)
    : check('system', 'node', 'fail', 'Node.js', `v${v} < 18`, 'https://nodejs.org  ·  nvm install --lts');
}

function gitCheck(root) {
  if (!which('git')) return check('system', 'git', 'warn', 'git', t('no instalado', 'not installed'), 'https://git-scm.com/downloads');
  const v = parseVersion(run('git', ['--version'], { timeoutMs: 5000 }).stdout);
  if (root && !exists(path.join(root, '.git'))) {
    return check('system', 'git', 'warn', 'git', t(`${v || ''} · este proyecto no es un repo`, `${v || ''} · this project is not a repo`).trim(), 'git init');
  }
  return check('system', 'git', 'ok', 'git', v || '');
}

function cliChecks(catalog, crewClis) {
  const res = [];
  const anyInstalled = catalog.some((x) => x.installed);
  for (const x of catalog) {
    const used = crewClis.includes(x.id);
    if (x.installed) {
      const r = run(x.bin, ['--version'], { timeoutMs: 5000 });
      const v = parseVersion(r.stdout || r.stderr);
      const slow = /ETIMEDOUT|timed? ?out/i.test(r.stderr);
      const detail = r.code === 0 ? (v || t('instalado', 'installed'))
        : slow ? t('instalado, pero --version no respondió en 5 s', 'installed, but --version did not answer in 5 s')
          : t('instalado, pero --version falló', 'installed, but --version failed');
      res.push(check('clis', x.id, r.code === 0 ? 'ok' : 'warn', x.label, detail, r.code === 0 ? '' : x.auth || ''));
      continue;
    }
    const status = used ? 'fail' : !crewClis.length && !anyInstalled ? 'fail' : 'skip';
    const detail = used ? t('lo usa tu equipo y no está instalado', 'your crew uses it and it is not installed') : t('no instalado (opcional)', 'not installed (optional)');
    res.push(check('clis', x.id, status, x.label, detail, x.install || x.docs || ''));
  }
  return res;
}

async function muxChecks(pref) {
  const res = [];
  let chosen = 'headless';
  let error = null;
  try { chosen = await detectMux(pref); } catch (e) { error = e; }
  for (const [id, m] of Object.entries(MUXES)) {
    const found = which(m.bin);
    const tag = chosen === id ? t(' ← se usará', ' ← will be used') : '';
    res.push(check('mux', id, found ? 'ok' : 'skip', m.label, (found ? t('instalado', 'installed') : t('no instalado', 'not installed')) + tag, found ? '' : m.install));
  }
  if (error) res.push(check('mux', 'selected', 'fail', t('Multiplexor configurado', 'Configured multiplexer'), error.message, error.hint || 'mora config set mux auto'));
  else if (chosen === 'headless') {
    res.push(check('mux', 'selected', 'warn', t('Paneles', 'Panes'), t('sin multiplexor: los agentes corren en segundo plano (headless)', 'no multiplexer: agents run in the background (headless)'), MUXES.tmux.install));
  } else if (MUXES[chosen] && !which(MUXES[chosen].bin)) {
    res.push(check('mux', 'selected', 'warn', t('Paneles', 'Panes'), t(`se detectó ${chosen} pero su CLI no está en el PATH`, `${chosen} detected but its CLI is not on PATH`), MUXES[chosen].install));
  } else res.push(check('mux', 'selected', 'ok', t('Paneles', 'Panes'), chosen));
  return { checks: res, chosen };
}

async function brainChecks(cfg) {
  let vaults = null;
  try {
    const mod = await import(new URL('../brain/obsidian.js', import.meta.url).href);
    if (typeof mod.findVaults === 'function') vaults = mod.findVaults();
  } catch { vaults = null; }
  const res = [];
  if (vaults === null) res.push(check('brain', 'vaults', 'skip', 'Obsidian', t('módulo brain no disponible', 'brain module not available')));
  else if (!vaults.length) res.push(check('brain', 'vaults', 'warn', 'Obsidian', t('no encontré vaults', 'no vaults found'), 'https://obsidian.md'));
  else res.push(check('brain', 'vaults', 'ok', 'Obsidian', vaults.slice(0, 3).map((v) => v.name).join(', ') + (vaults.length > 3 ? ` +${vaults.length - 3}` : '')));
  if (cfg) {
    const v = cfg.brain?.vault;
    if (!v) res.push(check('brain', 'linked', 'warn', t('Segundo cerebro', 'Second brain'), t('proyecto sin vault conectado', 'project has no vault linked'), 'mora brain link'));
    else res.push(check('brain', 'linked', exists(v) ? 'ok' : 'fail', t('Segundo cerebro', 'Second brain'), exists(v) ? `${v} (${cfg.brain.mode})` : t(`el vault ya no existe: ${v}`, `vault no longer exists: ${v}`), exists(v) ? '' : 'mora brain link'));
  }
  return res;
}

// Skill names that `mora sync` would copy, and whether every skills dir has an identical copy.
function skillsInSync(root, cfg, adapters) {
  const sources = [path.join(TEMPLATES, 'skills'), dirs(root).skills].filter(exists);
  const names = new Map();
  for (const src of sources) {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) if (e.isDirectory()) names.set(e.name, path.join(src, e.name, 'SKILL.md'));
  }
  const skillDirs = new Set();
  for (const m of Object.values(cfg.crew || {})) for (const s of adapters[m.cli]?.skillsDirs || []) skillDirs.add(s);
  const stale = [];
  for (const rel of skillDirs) {
    for (const [name, src] of names) {
      const dst = path.join(root, rel, name, 'SKILL.md');
      if (exists(src) && readText(dst, null) !== readText(src)) stale.push(path.join(rel, name));
    }
  }
  return { total: names.size * skillDirs.size, stale };
}

async function projectChecks(root) {
  const res = [];
  let cfg;
  try { cfg = loadConfig(root); } catch (e) {
    res.push(check('project', 'config', 'fail', 'moragent.json', e.message, e.hint));
    return { checks: res, cfg: null };
  }
  const problems = [];
  if (!PRESETS[cfg.preset]) problems.push(`preset "${cfg.preset}"`);
  const bad = Object.entries(cfg.crew || {}).filter(([, m]) => !CLI_IDS.includes(m?.cli)).map(([r, m]) => `${r}=${m?.cli}`);
  if (bad.length) problems.push(`cli ${bad.join(', ')}`);
  if (!Object.keys(cfg.crew || {}).length) problems.push(t('equipo vacío', 'empty crew'));
  res.push(problems.length
    ? check('project', 'config', 'fail', 'moragent.json', problems.join(' · '), 'mora config  ·  mora crew set <role> <cli>')
    : check('project', 'config', 'ok', 'moragent.json', `${cfg.project} · ${cfg.preset} · ${Object.keys(cfg.crew).length} ${t('roles', 'roles')}`));
  if (problems.length) return { checks: res, cfg };

  const dry = await syncProject(root, cfg, { dryRun: true });
  const missingBlock = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].filter((f) => exists(path.join(root, f)) && !readText(path.join(root, f)).includes('<!-- moragent:'));
  if (dry.files.length || missingBlock.length) {
    const names = [...new Set([...dry.files.map((f) => path.basename(f)), ...missingBlock])];
    res.push(check('project', 'instructions', 'warn', t('Instrucciones', 'Instructions'), t(`desactualizadas: ${names.join(', ')}`, `out of date: ${names.join(', ')}`), 'mora sync'));
  } else res.push(check('project', 'instructions', 'ok', t('Instrucciones', 'Instructions'), t('bloque moragent al día', 'moragent block up to date')));

  const adapters = await loadAdapters();
  const fallback = { claude: ['.claude/skills'] };
  const merged = Object.fromEntries(CLI_IDS.map((id) => [id, { skillsDirs: adapters[id]?.skillsDirs || fallback[id] || ['.agents/skills'] }]));
  const sk = skillsInSync(root, cfg, merged);
  if (!sk.total) res.push(check('project', 'skills', 'skip', 'Skills', t('sin skills para sincronizar', 'no skills to sync')));
  else if (sk.stale.length) res.push(check('project', 'skills', 'warn', 'Skills', t(`${sk.stale.length} sin sincronizar (${sk.stale[0]}…)`, `${sk.stale.length} not synced (${sk.stale[0]}…)`), 'mora sync'));
  else res.push(check('project', 'skills', 'ok', 'Skills', t(`${sk.total} copias al día`, `${sk.total} copies up to date`)));
  return { checks: res, cfg };
}

export async function diagnose(root) {
  const checks = [nodeCheck(), gitCheck(root)];
  let cfg = null;
  let project = [];
  if (root) ({ checks: project, cfg } = await projectChecks(root));
  const crewClis = cfg ? [...new Set(Object.values(cfg.crew || {}).map((m) => m.cli))] : [];
  checks.push(...cliChecks(await cliCatalog(), crewClis));
  const mux = await muxChecks(cfg?.mux || 'auto');
  checks.push(...mux.checks, ...(await brainChecks(cfg)), ...project);
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const x of checks) summary[x.status]++;
  return { ok: summary.fail === 0, root, mux: mux.chosen, summary, checks };
}

const ICON = { ok: () => c.green('✓'), warn: () => c.yellow('!'), fail: () => c.red('✗'), skip: () => c.dim('·') };
const GROUPS = [
  ['system', { es: 'Sistema', en: 'System' }],
  ['clis', { es: 'CLIs de agentes', en: 'Agent CLIs' }],
  ['mux', { es: 'Multiplexores', en: 'Multiplexers' }],
  ['brain', { es: 'Obsidian', en: 'Obsidian' }],
  ['project', { es: 'Proyecto', en: 'Project' }],
];

function render(r) {
  for (const [g, label] of GROUPS) {
    const list = r.checks.filter((x) => x.group === g);
    if (!list.length) continue;
    out(c.bold(t(label.es, label.en)));
    const w = Math.max(...list.map((x) => x.label.length));
    for (const x of list) {
      const detail = x.status === 'skip' ? c.dim(x.detail) : x.detail;
      out(`  ${ICON[x.status]()} ${x.label.padEnd(w)}  ${detail}`);
      if (x.fix && x.status !== 'ok') out(`    ${c.dim('→')} ${c.cyan(x.fix)}`);
    }
    out();
  }
  const s = r.summary;
  const line = `${c.green(`${s.ok} ok`)} · ${c.yellow(`${s.warn} ${t('avisos', 'warnings')}`)} · ${c.red(`${s.fail} ${t('errores', 'errors')}`)}`;
  out(r.ok ? `${c.green('✓')} ${t('Todo listo', 'All good')}  ${c.dim(line)}` : `${c.red('✗')} ${t('Hay que arreglar lo marcado con ✗', 'Fix the items marked ✗')}  ${line}`);
  if (!r.root) out(c.dim(t('  Fuera de un proyecto. Crea uno con: mora init', '  Not inside a project. Create one with: mora init')));
  out(c.dim(t('  Autenticación: abre cada CLI una vez para iniciar sesión (claude → /login, codex login…).', '  Auth: open each CLI once to sign in (claude → /login, codex login…).')));
}

export default {
  name: 'doctor',
  group: 'system',
  summary: { es: 'Revisa Node, CLIs, multiplexores, Obsidian y el proyecto', en: 'Check Node, CLIs, multiplexers, Obsidian and the project' },
  usage: 'mora doctor [--json]',
  async run(argv, ctx) {
    const r = await diagnose(ctx.root || findRoot());
    if (ctx.json) json(r);
    else render(r);
    return r.ok ? 0 : 1;
  },
};
