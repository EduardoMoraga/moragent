import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { slugify } from '../core/fsx.js';
import { MoragentError } from '../core/errors.js';
import { t } from '../core/i18n.js';
import { json, out } from '../core/log.js';
import { installedClis } from './init.js';

const COMPLEXITY = /\b(integrar|integrate|migrar|migrate|remoto|remote|varios|varias|multiple|persistente|persistent|seguridad|security|automatizar|automate|orquestar|orchestrate)\b/gi;

const WORDS_TO_IGNORE = new Set(['a', 'al', 'and', 'con', 'de', 'del', 'el', 'en', 'for', 'la', 'las', 'los', 'of', 'para', 'por', 'que', 'the', 'to', 'un', 'una', 'y']);
const words = (value) => new Set(String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !WORDS_TO_IGNORE.has(word)) || []);
const matchesWord = (set, word) => [...set].some((candidate) => candidate === word || (candidate.length >= 5 && word.length >= 5 && candidate.slice(0, 5) === word.slice(0, 5)));

// Match the project's configured missions, rather than assuming all projects
// need software roles. The size estimate remains a hint; the crew is the source
// of truth for which workers can actually receive tasks.
export function recommendRoles(idea, crew = {}, size = 'M', installed = null) {
  const request = words(idea);
  const usable = ([role, member]) => role !== 'lead' && (!installed || installed.includes(member.cli));
  const ranked = Object.entries(crew).filter(usable).map(([role, member]) => {
    const labels = [role, ...(Array.isArray(member.capabilities) ? member.capabilities : [])];
    const labelWords = words(labels.join(' '));
    const missionWords = words(typeof member.mission === 'string' ? member.mission : Object.values(member.mission || {}).join(' '));
    let score = 0;
    for (const word of request) score += (matchesWord(labelWords, word) ? 3 : 0) + (matchesWord(missionWords, word) ? 1 : 0);
    return { role, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));
  const count = size === 'S' ? 1 : size === 'M' ? 2 : size === 'L' ? 3 : 4;
  if (!ranked.length && Object.hasOwn(crew, 'executor') && usable(['executor', crew.executor])) return [{ role: 'executor', score: 0, source: 'generalist' }];
  return ranked.slice(0, count);
}

export function sizeIdea(idea) {
  const text = String(idea || '');
  const components = text.split(/,|;|\by\b|\band\b|\bcon\b|\bwith\b/gi).filter((part) => part.trim().length > 8).length;
  const complexity = new Set((text.match(COMPLEXITY) || []).map((word) => word.toLowerCase())).size;
  const score = Math.ceil(text.length / 140) + Math.min(components, 5) + Math.min(complexity, 3) * 2;
  const size = score <= 2 ? 'S' : score <= 5 ? 'M' : score <= 9 ? 'L' : 'XL';
  return { size, score, components, complexity };
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
    const installed = installedClis();
    const matches = recommendRoles(idea, cfg.crew, estimate.size, installed);
    const available = Object.entries(cfg.crew || {}).filter(([role, member]) => role !== 'lead' && installed.includes(member.cli)).map(([role]) => role);
    // Do not silently route an unrelated request to backend or frontend.
    const roles = ['lead', ...matches.map((match) => match.role)];
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
    const generalist = matches[0]?.source === 'generalist';
    const reasons = cfg.lang === 'en'
      ? [generalist ? 'No specialized capability matched; using the configured general executor.' : matches.length ? `Matched configured roles by mission and capabilities: ${matches.map((match) => match.role).join(', ')}.` : `No configured worker matches this request. Available: ${available.join(', ') || 'none'}.`, 'Review the role fit before dispatching work.']
      : [generalist ? 'No hubo una coincidencia especializada; se propone el ejecutor general configurado.' : matches.length ? `Roles afines por misión y capacidades: ${matches.map((match) => match.role).join(', ')}.` : `Ningún ejecutor configurado coincide con esta solicitud. Disponibles: ${available.join(', ') || 'ninguno'}.`, 'Revisa la afinidad del equipo antes de despachar trabajo.'];
    const result = { idea, ...estimate, preset: matches.length ? 'custom' : null, roles, matches, reasons, slug, spec };
    if (ctx.json) { json(result); return 0; }
    out(`${t('Tamaño', 'Size')}: ${estimate.size}`);
    out(`${t('Equipo', 'Crew')}: ${matches.length ? t('según capacidades', 'by capabilities') : t('sin coincidencia', 'no match')}`);
    out(`${t('Roles', 'Roles')}: ${roles.join(', ')}`);
    out('');
    for (const line of reasons) out(`- ${line}`);
    if (spec) out(`\n${t('Spec inicial', 'Initial spec')}: ${spec}`);
    return 0;
  },
};
