import fs from 'node:fs';
import path from 'node:path';
import { requireRoot, findRoot, dirs } from '../core/paths.js';
import { json, out, ok, info, err, c } from '../core/log.js';
import { t, setLang } from '../core/i18n.js';
import { MoragentError } from '../core/errors.js';
import { add, list, recall, promote, gc, getNote } from '../memory/index.js';
import { captureClaude, captureCodex } from '../memory/capture.js';

export default {
  name: 'memory',
  aliases: ['mem', 'm'],
  group: 'memory',
  summary: {
    es: 'Gestiona la memoria en capas (canónica, episódica, transitoria)',
    en: 'Manage layered memory (canonical, episodic, transient)',
  },
  usage: 'mora memory [add|list|recall|promote|gc|show|capture] [args...] [--json]',

  async run(argv, ctx) {
    if (ctx.lang) setLang(ctx.lang);
    if (argv.flags.lang) setLang(argv.flags.lang);
    const sub = argv._[0] || 'list';

    if (sub === 'capture') {
      // Runs launched by the native engine already become task memory; a session note would duplicate it.
      if (process.env.MORAGENT_ENGINE) return 0;
      try {
        const root = ctx.root || findRoot();
        if (!root) return 0; // Silent exit if not a MORAGENT project

        const from = argv.flags.from || argv.flags.source;
        if (!from || !['claude', 'codex'].includes(from)) return 0;

        let payload = ctx.payload || argv.flags.payload || null;
        const argJson = argv._.slice(1).join(' ').trim();
        if (!payload && argJson) {
          try { payload = JSON.parse(argJson); } catch { payload = argJson; }
        } else if (!payload && !process.stdin.isTTY) {
          try {
            const raw = fs.readFileSync(0, 'utf8');
            if (raw && raw.trim()) payload = JSON.parse(raw);
          } catch { /* ignore parse error */ }
        }

        if (!payload) return 0;

        let res = null;
        if (from === 'claude') {
          res = captureClaude(payload, { root });
        } else if (from === 'codex') {
          res = captureCodex(payload, { root });
        }

        if (ctx.json && res) {
          json({ ok: true, ...res });
        }
        return 0;
      } catch (err) {
        try {
          const r = ctx.root || findRoot();
          if (r) {
            const logPath = path.join(dirs(r).runs, 'capture.log');
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] Capture error: ${err.message}\n${err.stack}\n`);
          }
        } catch { /* ignore */ }
        return 0;
      }
    }

    const root = ctx.root || requireRoot();

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
      const by = argv.flags.by || process.env.MORAGENT_ROLE || 'user';

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
        throw new MoragentError('USAGE', 'mora memory recall "<query>" [--tier] [--limit] [--specs]');
      }

      const limit = argv.flags.limit ? Number(argv.flags.limit) : 8;
      const tiers = argv.flags.tier;
      const includeSpecs = !!(argv.flags.specs || argv.flags['include-specs']);
      const results = recall({ root, query, tiers, limit, includeSpecs });

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
        const tierBadge = r.note.tier === 'canonical' ? c.cyan(`[${r.note.tier}]`) : r.note.tier === 'spec' ? c.magenta(`[${r.note.tier}]`) : c.green(`[${r.note.tier}]`);
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
      const authorLabel = t('Autor', 'Author');
      const dateLabel = t('Fecha', 'Date');
      const unkLabel = t('desconocido', 'unknown');
      out(c.dim(`ID: ${note.id} | Tier: ${note.tier} | Kind: ${note.kind} | ${authorLabel}: @${note.by || unkLabel} | ${dateLabel}: ${note.created || unkLabel}`));
      if (note.tags?.length) out(c.dim(`${t('Etiquetas', 'Tags')}: ${note.tags.join(', ')}`));
      if (note.links?.length) out(c.dim(`${t('Enlaces', 'Links')}: ${note.links.map((l) => `[[${l}]]`).join(' ')}`));
      out('');
      out(note.body || c.italic(t('_Sin contenido adicional._', '_No additional content._')));
      return 0;
    }

    throw new MoragentError('USAGE', t(`Subcomando desconocido: ${sub}`, `Unknown subcommand: ${sub}`), this.usage);
  },
};
