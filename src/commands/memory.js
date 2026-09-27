import fs from 'node:fs';
import path from 'node:path';
import { requireRoot } from '../core/paths.js';
import { json, out, ok, info, err, c } from '../core/log.js';
import { t } from '../core/i18n.js';
import { MoragentError } from '../core/errors.js';
import { add, list, recall, promote, gc, getNote } from '../memory/index.js';

export default {
  name: 'memory',
  aliases: ['mem', 'm'],
  group: 'memory',
  summary: {
    es: 'Gestiona la memoria en capas (canónica, episódica, transitoria)',
    en: 'Manage layered memory (canonical, episodic, transient)',
  },
  usage: 'mora memory [add|list|recall|promote|gc|show] [args...] [--json]',

  async run(argv, ctx) {
    const root = ctx.root || requireRoot();
    const sub = argv._[0] || 'list';

    if (sub === 'add') {
      const title = argv._[1];
      if (!title) {
        throw new MoragentError('USAGE', 'mora memory add "<title>" [--tier canonical|episodic|transient] [--kind] [--body "..."]');
      }

      let body = argv.flags.body || '';
      if (!body && argv.flags.file) {
        try {
          body = fs.readFileSync(path.resolve(argv.flags.file), 'utf8');
        } catch (e) {
          throw new MoragentError('FILE_ERROR', t(`No se pudo leer el archivo: ${argv.flags.file}`, `Could not read file: ${argv.flags.file}`));
        }
      } else if (!body && !process.stdin.isTTY) {
        try {
          body = fs.readFileSync(0, 'utf8');
        } catch {
          body = '';
        }
      }

      const tier = argv.flags.tier || 'episodic';
      const kind = argv.flags.kind;
      const tags = argv.flags.tags;
      const links = argv.flags.links;
      const by = argv.flags.by || 'helper';

      const res = add({ root, tier, kind, title, body, tags, links, by });

      if (ctx.json) {
        json({ ok: true, id: res.id, path: res.path, tier: res.note.tier, kind: res.note.kind, title: res.note.title });
      } else {
        ok(t(`Nota guardada: ${c.bold(res.id)} [${res.note.tier}]`, `Memory note saved: ${c.bold(res.id)} [${res.note.tier}]`));
      }
      return 0;
    }

    if (sub === 'list') {
      const tier = argv.flags.tier;
      const limit = argv.flags.limit ? Number(argv.flags.limit) : 30;
      const notes = list({ root, tier, limit });

      if (ctx.json) {
        json(notes);
        return 0;
      }

      if (notes.length === 0) {
        info(t('No hay notas de memoria registradas.', 'No memory notes found.'));
        return 0;
      }

      out(c.bold(t(`Notas de memoria (${notes.length}):`, `Memory notes (${notes.length}):`)));
      for (const n of notes) {
        const tierBadge = n.tier === 'canonical' ? c.cyan(`[${n.tier}]`) : n.tier === 'episodic' ? c.green(`[${n.tier}]`) : c.yellow(`[${n.tier}]`);
        const tagsStr = n.tags && n.tags.length ? c.dim(` #${n.tags.join(' #')}`) : '';
        const byStr = n.by ? c.dim(` (@${n.by})`) : '';
        out(`  ${tierBadge.padEnd(20)} ${c.bold(n.id)} — ${n.title}${tagsStr}${byStr}`);
      }
      return 0;
    }

    if (sub === 'recall') {
      const query = argv._[1] || argv.flags.query;
      if (!query) {
        throw new MoragentError('USAGE', 'mora memory recall "<query>" [--tier] [--limit]');
      }

      const limit = argv.flags.limit ? Number(argv.flags.limit) : 8;
      const tiers = argv.flags.tier;
      const results = recall({ root, query, tiers, limit });

      if (ctx.json) {
        json(results);
        return 0;
      }

      if (results.length === 0) {
        info(t(`Sin coincidencias para: "${query}"`, `No memory notes matched: "${query}"`));
        return 0;
      }

      out(c.bold(t(`Coincidencias para "${query}" (${results.length}):`, `Matches for "${query}" (${results.length}):`)));
      for (const r of results) {
        const scoreBadge = c.brand(`[${r.score.toFixed(2)}]`);
        const tierBadge = r.note.tier === 'canonical' ? c.cyan(`[${r.note.tier}]`) : c.green(`[${r.note.tier}]`);
        out(`  ${scoreBadge} ${tierBadge} ${c.bold(r.note.title)} (${c.dim(r.note.id)})`);
        if (r.snippet) {
          out(c.dim(`      > ${r.snippet}`));
        }
      }
      return 0;
    }

    if (sub === 'promote') {
      const id = argv._[1];
      if (!id) {
        throw new MoragentError('USAGE', 'mora memory promote <id> [--kind decision]');
      }

      const kind = argv.flags.kind || 'decision';
      const promoted = promote({ root, id, kind });

      if (ctx.json) {
        json({ ok: true, note: promoted });
      } else {
        ok(t(`Nota ${c.bold(id)} promovida a canonical como "${promoted.id}" (${promoted.kind})`, `Note ${c.bold(id)} promoted to canonical as "${promoted.id}" (${promoted.kind})`));
      }
      return 0;
    }

    if (sub === 'gc') {
      const days = argv.flags.days ? Number(argv.flags.days) : undefined;
      const dryRun = !!argv.flags['dry-run'];
      const res = gc({ root, days, dryRun });

      if (ctx.json) {
        json(res);
        return 0;
      }

      if (res.count === 0) {
        ok(t('Memoria transitoria limpia: nada que purgar.', 'Transient memory clean: nothing to collect.'));
      } else if (dryRun) {
        info(t(`[dry-run] Se purgarían ${res.count} notas transitorias expiradas.`, `[dry-run] Would purge ${res.count} expired transient notes.`));
      } else {
        ok(t(`Se purgaron ${res.count} notas transitorias expiradas.`, `Purged ${res.count} expired transient notes.`));
      }
      return 0;
    }

    if (sub === 'show') {
      const id = argv._[1];
      if (!id) {
        throw new MoragentError('USAGE', 'mora memory show <id>');
      }

      const note = getNote(root, id);
      if (!note) {
        throw new MoragentError('NOTE_NOT_FOUND', t(`Nota no encontrada: ${id}`, `Note not found: ${id}`), 'mora memory list');
      }

      if (ctx.json) {
        json(note);
        return 0;
      }

      out(c.bold(note.title));
      out(c.dim(`ID: ${note.id} | Tier: ${note.tier} | Kind: ${note.kind} | Author: @${note.by || 'unknown'} | Date: ${note.created || 'unknown'}`));
      if (note.tags?.length) out(c.dim(`Tags: ${note.tags.join(', ')}`));
      if (note.links?.length) out(c.dim(`Links: ${note.links.map((l) => `[[${l}]]`).join(' ')}`));
      out('');
      out(note.body || c.italic(t('_Sin contenido adicional._', '_No additional content._')));
      return 0;
    }

    throw new MoragentError('USAGE', `Unknown subcommand: ${sub}`, this.usage);
  },
};
