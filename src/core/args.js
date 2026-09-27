// Minimal argv parser: positionals + --flag value | --flag=value | -f | --no-flag.
// Flags listed in `booleans` never consume the next token.
export function parse(tokens, { booleans = [] } = {}) {
  const out = { _: [], flags: {} };
  const bool = new Set(['json', 'yes', 'dry-run', 'help', 'headless', 'force', 'all', 'quiet', 'verbose', ...booleans]);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') { out._.push(...tokens.slice(i + 1)); break; }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) { out.flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (body.startsWith('no-')) { out.flags[body.slice(3)] = false; continue; }
      const next = tokens[i + 1];
      if (!bool.has(body) && next !== undefined && !next.startsWith('-')) { out.flags[body] = next; i++; }
      else out.flags[body] = true;
      continue;
    }
    if (tok.length > 1 && tok.startsWith('-') && !/^-\d/.test(tok)) {
      for (const ch of tok.slice(1)) out.flags[SHORT[ch] || ch] = true;
      continue;
    }
    out._.push(tok);
  }
  return out;
}

const SHORT = { h: 'help', y: 'yes', j: 'json', v: 'version', q: 'quiet' };

export function flagList(v) {
  if (v === undefined || v === true || v === false) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}
