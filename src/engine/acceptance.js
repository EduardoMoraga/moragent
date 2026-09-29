import fs from 'node:fs';
import path from 'node:path';

const outside = (relative) => relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
const description = (bytes) => `${bytes.length} bytes, final LF: ${bytes.at(-1) === 10 ? 'yes' : 'no'}, tail: ${JSON.stringify(bytes.subarray(-80).toString('utf8'))}`;

export function isValidFileTextCheck(check) {
  const parts = typeof check?.path === 'string' ? check.path.split('/') : [];
  // The workspace intentionally never publishes these paths. Accepting a
  // check for one could report verifiedChecks while leaving the source absent.
  // Fold case so the rule is safe on case-insensitive macOS/Windows volumes.
  const excluded = parts.some((part, index) => {
    const name = part.toLowerCase();
    return name === '.git' || name === 'node_modules'
      || (name === '.moragent' && ['runs', 'tasks', 'sessions', 'memory'].includes(parts[index + 1]?.toLowerCase()));
  });
  const validPath = typeof check?.path === 'string' && check.path.length > 0 && check.path.length <= 500
    && !/[\\:\u0000-\u001f\u007f]/.test(check.path) && !check.path.startsWith('/')
    && parts.every((part) => part && part !== '.' && part !== '..') && !excluded;
  const validLines = Array.isArray(check?.lines) && check.lines.length <= 200
    && check.lines.every((line) => typeof line === 'string' && line.length <= 10000 && !/[\r\n]/.test(line))
    && check.lines.reduce((size, line) => size + line.length, 0) <= 100000;
  return !!check && typeof check === 'object' && !Array.isArray(check)
    && check.type === 'file_text' && validPath && validLines && typeof check.finalNewline === 'boolean';
}

// Optional user-authored contract for exact multi-file or multi-line content:
// ```moragent-checks
// {"files":[{"path":"a.txt","lines":["first","second"],"finalNewline":true}]}
// ```
// Parse JSON by balanced braces so a literal ``` inside a line is not mistaken
// for the closing fence. The model must never be the sole source of these bytes.
export function parseExplicitFileChecks(request) {
  const source = String(request || '');
  const mentions = [...source.matchAll(/```moragent-checks\b/gi)];
  if (!mentions.length) return null;
  if (mentions.length !== 1) return { error: 'multiple-blocks' };
  const markers = [...source.matchAll(/```moragent-checks[ \t]*\r?\n/gi)];
  if (markers.length !== 1) return { error: 'missing-fence' };
  const from = markers[0].index + markers[0][0].length;
  const first = source.slice(from).search(/\S/);
  if (first < 0 || source[from + first] !== '{') return { error: 'invalid-json' };
  const start = from + first;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = index + 1; break; }
    if (index - start > 262144) return { error: 'too-large' };
  }
  if (end < 0) return { error: 'invalid-json' };
  if (end - start > 262144) return { error: 'too-large' };
  if (!/^\s*```/.test(source.slice(end))) return { error: 'missing-fence' };
  let parsed;
  try { parsed = JSON.parse(source.slice(start, end)); } catch { return { error: 'invalid-json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== 'files')
      || !Array.isArray(parsed.files) || parsed.files.length < 1 || parsed.files.length > 32) return { error: 'invalid-files' };
  const seen = new Set();
  const checks = [];
  for (const file of parsed.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).some((key) => !['path', 'lines', 'finalNewline'].includes(key))) return { error: 'invalid-check' };
    const check = { type: 'file_text', ...file };
    if (!isValidFileTextCheck(check)) return { error: 'invalid-check' };
    const key = check.path.toLowerCase();
    if (seen.has(key)) return { error: 'duplicate-path' };
    seen.add(key);
    checks.push(check);
  }
  return { checks };
}

// A request for exact text needs at least one structured plan check. This is a
// routing signal, not an attempt to infer expected bytes from arbitrary prose.
export function requiresExactFileCheck(request) {
  const text = String(request || '');
  return /\bfile_text\b|\bbyte[- ]exact\b|\bexact (?:file|text(?:-file)?) content\b|\b(?:final|trailing) (?:LF|newline)\b|\bLF newline\b|contenido exacto|salto de línea final|LF final/i.test(text);
}

// Only bind a plan check to a path when the request names one unambiguous file.
// Multiple filenames may include references, so the model must resolve those.
export function exactCheckTarget(request) {
  const candidates = [...new Set(String(request || '').match(/\b[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z][A-Za-z0-9_-]{0,9}\b/g) || [])];
  return candidates.length === 1 ? candidates[0] : null;
}

// Anchor only unambiguous, single-line literals in the person's own request.
// This deliberately returns null for arbitrary prose or multi-line content: the
// model's check remains mandatory, but we must not invent bytes from a guess.
export function literalSingleLineExpectation(request) {
  const text = String(request || '').trim();
  const target = exactCheckTarget(text);
  if (!target || /[\r\n]/.test(text)) return null;

  let rawLine = null;
  let finalNewline = null;
  let fromColon = false;
  const colon = text.indexOf(':');
  if (colon >= 0) {
    const lead = text.slice(0, colon);
    if (/(?:containing exactly|exact file content|contenido exacto|exactamente (?:esta|una) línea)/i.test(lead)) {
      if (/(?:without (?:a |one )?final (?:LF )?newline|sin (?:un )?(?:salto de línea final|LF final))/i.test(lead)) finalNewline = false;
      else if (/(?:final (?:LF )?newline|salto de línea final|LF final)/i.test(lead)) finalNewline = true;
      if (finalNewline !== null) { rawLine = text.slice(colon + 1); fromColon = true; }
    }
  }
  if (rawLine === null) {
    const english = text.match(/\b(?:containing exactly|with exact file content)\s+(.+?)\s+(?:with|and|followed by)\s+(?:(?:a|one)\s+)?(final|trailing)\s+(?:LF\s+)?newline\.?$/i);
    if (english) { rawLine = english[1]; finalNewline = true; }
  }
  if (rawLine === null) {
    const spanish = text.match(/\bcon (?:el )?contenido exacto\s+(.+?)\s+y\s+(?:un\s+)?(?:salto de línea final|LF final)\.?$/i);
    if (spanish) { rawLine = spanish[1]; finalNewline = true; }
  }
  if (rawLine === null) return null;

  let line = rawLine.trim();
  const quote = line[0];
  const quoted = line.length >= 2 && ['"', "'", '`'].includes(quote) && line.at(-1) === quote;
  if (quoted) line = line.slice(1, -1);
  // After a colon, an unquoted phrase may include further instructions. Anchor
  // only a single token there; use quotes for exact lines containing spaces.
  if (fromColon && !quoted && !/^[\p{L}\p{N}_+./-]+$/u.test(line)) return null;
  // An unquoted second sentence is likely more instruction, not literal bytes.
  if (!quoted && /[.!?;]\s+\S/.test(line)) return null;
  if (!line || line.length > 10000 || /[\r\n]/.test(line)) return null;
  return { type: 'file_text', path: target, lines: [line], finalNewline };
}

// Only structured, exact file checks are machine-verifiable. Natural-language
// doneWhen remains a reviewer criterion, not an invented assertion.
export function verifyTaskChecks(root, checks = []) {
  const failures = [];
  const realRoot = fs.realpathSync(root);
  for (const check of checks) {
    const target = path.resolve(realRoot, ...check.path.split('/'));
    if (outside(path.relative(realRoot, target))) {
      failures.push(`${check.path}: path escapes the private project`);
      continue;
    }
    const expected = Buffer.from(check.lines.join('\n') + (check.finalNewline ? '\n' : ''), 'utf8');
    try {
      if (!fs.lstatSync(target).isFile() || outside(path.relative(realRoot, fs.realpathSync(target)))) {
        failures.push(`${check.path}: not a regular file inside the private project`);
        continue;
      }
      const actual = fs.readFileSync(target);
      if (!actual.equals(expected)) failures.push(`${check.path}: expected ${description(expected)}; got ${description(actual)}`);
    } catch (error) {
      failures.push(`${check.path}: ${error.code === 'ENOENT' ? 'file is missing' : error.message}`);
    }
  }
  return failures;
}
