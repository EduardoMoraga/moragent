import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { slugify } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out } from '../core/log.js';

const SIGNALS = {
  frontend: /\b(frontend|front-end|ui|ux|interfaz|pantalla|web|react|css|dashboard|landing|accesibilidad)\b/i,
  backend: /\b(backend|back-end|api|servidor|server|auth|base de datos|database|sql|endpoint|integraci[oó]n)\b/i,
  dev: /\b(ci|cd|deploy|infra|docker|kubernetes|pipeline|instalador|package|npm|release)\b/i,
  helper: /\b(test|prueba|qa|investiga|research|revisi[oó]n|seguridad|security|rendimiento|performance)\b/i,
  data: /\b(datos|data|analytics|m[eé]trica|etl|modelo|machine learning|ia|ai)\b/i,
};

const PRESET_ROLES = {
  solo: ['lead'],
  duo: ['lead', 'backend'],
  trio: ['lead', 'backend', 'frontend'],
  squad: ['lead', 'backend', 'frontend', 'helper', 'dev'],
};

const presetForCount = (count) => count <= 1 ? 'solo' : count <= 2 ? 'duo' : count <= 3 ? 'trio' : 'squad';

export function sizeIdea(idea) {
  const roles = ['lead'];
  let domains = 0;
  for (const [name, pattern] of Object.entries(SIGNALS)) {
    if (!pattern.test(idea)) continue;
    domains++;
    const role = name === 'data' ? 'backend' : name;
    if (!roles.includes(role)) roles.push(role);
  }
  if (roles.length === 1) roles.push('backend');
  const components = idea.split(/,|;|\by\b|\band\b/gi).filter((part) => part.trim().length > 8).length;
  const score = Math.ceil(idea.length / 100) + domains * 2 + Math.min(components, 4);
  const size = score <= 3 ? 'S' : score <= 6 ? 'M' : score <= 10 ? 'L' : 'XL';
  let preset = size === 'S' ? 'solo' : size === 'M' ? 'duo' : size === 'L' ? 'trio' : 'squad';
  let wanted = [...new Set([...PRESET_ROLES[preset], ...roles])];
  for (;;) {
    const coherent = presetForCount(wanted.length);
    if (coherent === preset) break;
    preset = coherent;
    wanted = [...new Set([...PRESET_ROLES[preset], ...wanted])];
  }
  return { size, preset, roles: wanted, score, domains, components };
}

export default {
  name: 'plan',
  group: 'crew',
  summary: { es: 'Dimensiona una idea y recomienda equipo', en: 'Size an idea and recommend a crew' },
  usage: 'mora plan "<idea>" [--json]',
  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const cfg = ctx.config || loadConfig(root);
    const idea = argv._.join(' ').trim();
    if (!idea) throw new MoragentError('USAGE', this.usage);
    const estimate = sizeIdea(idea);
    // A slug is a folder name people type: keep the first meaningful words of the idea, not all of it.
    const slug = typeof argv.flags.slug === 'string' ? slugify(argv.flags.slug)
      : slugify((typeof argv.flags.title === 'string' ? argv.flags.title : idea).split(/[,.:;(]/)[0].split(/\s+/).slice(0, 4).join(' '));
    let spec = null;
    try {
      const specs = await import('../spec/index.js');
      if (typeof specs.newSpec === 'function') spec = await specs.newSpec({ root, slug, title: idea.slice(0, 100), lang: cfg.lang });
    } catch (error) {
      if (error?.code === 'SPEC_EXISTS') spec = path.join(dirs(root).specs, slug);
      else if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    const reasons = cfg.lang === 'en'
      ? [`Detected ${estimate.domains} technical domain(s).`, `The description implies ${estimate.components || 1} component(s) and scores ${estimate.score}.`, `Recommended ${estimate.preset} so ${estimate.roles.join(', ')} can cover the scope.`]
      : [`Se detectaron ${estimate.domains} dominio(s) técnicos.`, `La descripción implica ${estimate.components || 1} componente(s) y suma ${estimate.score} puntos.`, `Se recomienda ${estimate.preset} para cubrir el alcance con ${estimate.roles.join(', ')}.`];
    const result = { idea, ...estimate, reasons, slug, spec };
    if (ctx.json) { json(result); return 0; }
    out(`${t('Tamaño', 'Size')}: ${estimate.size}`);
    out(`${t('Preset', 'Preset')}: ${estimate.preset}`);
    out(`${t('Roles', 'Roles')}: ${estimate.roles.join(', ')}`);
    out('');
    for (const line of reasons) out(`- ${line}`);
    if (spec) out(`\n${t('Spec inicial', 'Initial spec')}: ${spec}`);
    return 0;
  },
};
