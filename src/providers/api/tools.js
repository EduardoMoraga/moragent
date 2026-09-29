import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { terminateTree } from '../../core/exec.js';
import { MoragentError } from '../../core/errors.js';
import { getLang, t } from '../../core/i18n.js';

export const MAX_OUTPUT_BYTES = 20 * 1024; // 20 KB
const MAX_EDIT_FILE_BYTES = 16 * 1024 * 1024;
const BASH_TIMEOUT_MS = 120000;
const DEFAULT_GREP_TIMEOUT_MS = 30000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

function hasDirectoryEntry(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

export function truncateOutput(str, maxBytes = MAX_OUTPUT_BYTES) {
  if (typeof str !== 'string') str = String(str ?? '');
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  const notice = '\n... [output truncated to 20 KB / salida truncada a 20 KB]';
  const noticeBuf = Buffer.from(notice, 'utf8');
  const sliceLen = Math.max(0, maxBytes - noticeBuf.length);
  let validLen = sliceLen;
  // If the next byte continues a multibyte code point, back up to its start.
  // Decoding a partial character as U+FFFD would exceed the byte budget.
  while (validLen > 0 && (buf[validLen] & 0xc0) === 0x80) validLen--;
  const cut = buf.subarray(0, validLen).toString('utf8');
  return cut + notice;
}

export function assertPathInside(root, targetPath) {
  if (!root) {
    throw new MoragentError('NO_ROOT', 'Project root is required for path resolution');
  }
  const rootResolved = path.resolve(root);
  const realRoot = fs.existsSync(rootResolved) ? fs.realpathSync(rootResolved) : rootResolved;

  const targetResolved = path.resolve(realRoot, targetPath || '.');

  // Relative path lexical check against resolved root
  const relLexical = path.relative(realRoot, targetResolved);
  if (isOutside(relLexical)) {
    throw new MoragentError('PATH_OUTSIDE_ROOT',
      t(`La ruta "${targetPath}" escapa de la raíz del proyecto`,
        `Path "${targetPath}" escapes the project root`));
  }

  // lstat also sees dangling symlinks, which existsSync hides. A broken link must
  // never be treated as a fresh file because writeFileSync would follow it.
  if (hasDirectoryEntry(targetResolved)) {
    const realTarget = fs.realpathSync(targetResolved);
    const relReal = path.relative(realRoot, realTarget);
    if (isOutside(relReal)) {
      throw new MoragentError('PATH_OUTSIDE_ROOT',
        t(`El enlace simbólico "${targetPath}" apunta fuera de la raíz`,
          `Symlink "${targetPath}" resolves outside the project root`));
    }
    return targetResolved;
  }

  // If target does not exist yet (e.g. write_file), check closest existing ancestor directory
  let curr = path.dirname(targetResolved);
  while (!hasDirectoryEntry(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  if (hasDirectoryEntry(curr)) {
    const realAncestor = fs.realpathSync(curr);
    const relAncestor = path.relative(realRoot, realAncestor);
    if (isOutside(relAncestor)) {
      throw new MoragentError('PATH_OUTSIDE_ROOT',
        t(`La ruta de destino "${targetPath}" está en un directorio que escapa de la raíz`,
          `Destination path "${targetPath}" is within a directory that escapes the project root`));
    }
  }

  return targetResolved;
}

function isOutside(relativePath) {
  return relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function makeSummary(str, max = 200) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + '...';
}

function oversizedEditResult(target) {
  const output = t(
    `Error: ${target} es demasiado grande para edit_file (máximo 16 MiB). Usa grep y divide la edición en un archivo más pequeño.`,
    `Error: ${target} is too large for edit_file (16 MiB maximum). Use grep and split the edit into a smaller file.`,
  );
  return { ok: false, output, summary: makeSummary(output) };
}

// Canonical tool definitions
export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a file within the project root by streaming. Use offset and limit for selected lines; output is capped at 20 KB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file inside the project root' },
        offset: { type: 'integer', description: 'Optional 1-based line number to start reading from' },
        limit: { type: 'integer', description: 'Optional maximum number of lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a file within the project root. Provide either content, or lines plus final_newline for exact LF bytes without escape ambiguity. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file inside the project root' },
        content: { type: 'string', description: 'Text to write verbatim; do not also provide lines or final_newline' },
        lines: { type: 'array', items: { type: 'string' }, description: 'Alternative to content: exact text lines without embedded CR or LF characters' },
        final_newline: { type: 'boolean', description: 'Required with lines: true appends exactly one final LF byte; false appends none' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact, unique occurrence of old_string with new_string in a file within the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file inside the project root' },
        old_string: { type: 'string', description: 'The exact string to find and replace (must appear exactly once)' },
        new_string: { type: 'string', description: 'The replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories in a directory within the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path to list (defaults to ".")' },
      },
    },
  },
  {
    name: 'grep',
    description: 'Search for a regex pattern in files within the project root.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression or text pattern to search for' },
        path: { type: 'string', description: 'Directory or file path to search within (defaults to ".")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a shell command within the project root. Refused when autonomy is "ask".',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
];

export function filterToolsForAutonomy(autonomy = 'auto') {
  if (autonomy === 'readonly' || autonomy === 'ask') {
    return TOOL_DEFINITIONS.filter((t) => ['read_file', 'list_dir', 'grep'].includes(t.name));
  }
  if (autonomy === 'full') return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((t) => t.name !== 'bash');
}

export function getAnthropicTools({ autonomy } = {}) {
  return filterToolsForAutonomy(autonomy).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function getOpenAITools({ autonomy } = {}) {
  return filterToolsForAutonomy(autonomy).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function getGeminiTools({ autonomy } = {}) {
  const mapType = (t) => {
    switch (t) {
      case 'object': return 'OBJECT';
      case 'string': return 'STRING';
      case 'integer': return 'INTEGER';
      case 'number': return 'NUMBER';
      case 'boolean': return 'BOOLEAN';
      case 'array': return 'ARRAY';
      default: return 'STRING';
    }
  };

  const convertSchema = (schema) => {
    if (!schema) return { type: 'OBJECT' };
    const res = { type: mapType(schema.type) };
    if (schema.description) res.description = schema.description;
    if (schema.properties) {
      res.properties = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        res.properties[k] = convertSchema(v);
      }
    }
    if (schema.items) res.items = convertSchema(schema.items);
    if (schema.required) res.required = schema.required;
    return res;
  };

  return [
    {
      functionDeclarations: filterToolsForAutonomy(autonomy).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: convertSchema(tool.parameters),
      })),
    },
  ];
}

// Tool implementation handlers
async function readSelectedLines(handle, startLine, endLine, maxBytes, signal) {
  const input = handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
  const chunks = [];
  let bytes = 0;
  let line = 1;
  let done = false;
  // Destroy without an Error: FileHandle streams may emit that error after the
  // async iterator has settled, crashing the process on a late cancellation.
  const abort = () => input.destroy();
  const capture = (piece) => {
    if (!piece.length) return;
    const take = Math.min(piece.length, maxBytes - bytes);
    if (take > 0) {
      chunks.push(Buffer.from(piece.subarray(0, take)));
      bytes += take;
    }
    if (take < piece.length) done = true;
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    for await (const chunk of input) {
      if (signal?.aborted) throw new Error('Aborted');
      let pos = 0;
      while (pos < chunk.length && !done) {
        const newline = chunk.indexOf(10, pos);
        const end = newline < 0 ? chunk.length : newline;
        if (line >= startLine && line <= endLine) capture(chunk.subarray(pos, end));
        if (newline < 0 || done) break;
        if (line >= startLine && line < endLine) capture(Buffer.from('\n'));
        line++;
        pos = newline + 1;
        if (line > endLine) done = true;
      }
      if (done) break;
    }
    if (signal?.aborted) throw new Error('Aborted');
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', abort);
    input.destroy();
  }
}

async function handleReadFile(args, root, signal) {
  const target = args.path || args.file_path;
  if (!target) {
    return { ok: false, output: 'Error: missing path parameter', summary: 'Missing path' };
  }
  const resolved = assertPathInside(root, target);
  if (!fs.existsSync(resolved)) {
    return { ok: false, output: `Error: File not found: ${target}`, summary: `File not found: ${target}` };
  }
  const offset = Number.parseInt(args.offset, 10);
  const limit = Number.parseInt(args.limit, 10);
  const startLine = !Number.isNaN(offset) && offset > 0 ? offset : 1;
  const endLine = !Number.isNaN(limit) && limit > 0 ? startLine + limit - 1 : Infinity;
  // O_NONBLOCK prevents a target swapped for a FIFO after path validation from
  // hanging open(). Regular files ignore it. fstat checks the opened descriptor.
  const handle = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, output: `Error: ${target} is not a regular file`, summary: `${target} is not a regular file` };
    }
    const tail = Buffer.alloc(2);
    if (stat.size >= 2) await handle.read(tail, 0, 2, stat.size - 2);
    const literalEscapedNewline = stat.size >= 2 && tail[0] === 92 && tail[1] === 110;
    const warning = literalEscapedNewline ? 'WARNING: file ends with literal backslash + n characters, not a final LF newline.\n' : '';
    const text = await readSelectedLines(handle, startLine, endLine, MAX_OUTPUT_BYTES - Buffer.byteLength(warning) + 1, signal);
    const output = truncateOutput(`${warning}${text}`);
    const summary = `Read ${target} (${Buffer.byteLength(text, 'utf8')} bytes shown${output.includes('[output truncated') ? ', truncated' : ''})`;
    return { ok: true, output, summary: makeSummary(summary) };
  } catch (error) {
    if (signal?.aborted) {
      const msg = t('Lectura cancelada.', 'Read cancelled.');
      return { ok: false, output: msg, summary: msg };
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function handleWriteFile(args, root) {
  const target = args.path || args.file_path;
  if (!target) {
    return { ok: false, output: 'Error: missing path parameter', summary: 'Missing path' };
  }
  const hasContent = Object.hasOwn(args, 'content');
  const hasLines = Object.hasOwn(args, 'lines');
  if (hasContent === hasLines || (hasContent && Object.hasOwn(args, 'final_newline'))) {
    return { ok: false, output: 'Error: provide either content or lines with final_newline, not both', summary: 'Ambiguous or missing file content' };
  }
  let content;
  if (hasContent) {
    if (typeof args.content !== 'string') {
      return { ok: false, output: 'Error: content must be a string (use "" to write an empty file)', summary: 'Missing or invalid content' };
    }
    content = args.content;
  } else {
    if (!Array.isArray(args.lines) || args.lines.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))
        || typeof args.final_newline !== 'boolean') {
      return { ok: false, output: 'Error: lines must be strings without CR/LF and final_newline must be a boolean', summary: 'Invalid exact lines' };
    }
    content = args.lines.join('\n') + (args.final_newline ? '\n' : '');
  }
  const resolved = assertPathInside(root, target);
  if (hasDirectoryEntry(resolved) && !fs.statSync(resolved).isFile()) {
    return { ok: false, output: `Error: ${target} is not a regular file`, summary: `${target} is not a regular file` };
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');

  const bytes = Buffer.byteLength(content, 'utf8');
  const newline = content.endsWith('\n') ? 'yes' : 'no';
  const escapedWarning = content.endsWith('\\n') && !content.endsWith('\n')
    ? ' WARNING: the final backslash + n are literal characters, not a newline.' : '';
  const summary = `Wrote ${bytes} bytes to ${target}; final LF newline: ${newline}.${escapedWarning}`;
  return { ok: true, output: `Successfully wrote ${bytes} bytes to ${target}. Final LF newline: ${newline}.${escapedWarning}`, summary: makeSummary(summary) };
}

async function handleEditFile(args, root) {
  const target = args.path || args.file_path;
  if (!target) {
    return { ok: false, output: 'Error: missing path parameter', summary: 'Missing path' };
  }
  const oldStr = args.old_string ?? args.old_str ?? args.find ?? args.target;
  const newStr = args.new_string ?? args.new_str ?? args.replace;
  if (typeof oldStr !== 'string' || oldStr.length === 0) {
    return { ok: false, output: 'Error: old_string must be a nonempty string', summary: 'Missing or invalid old_string' };
  }
  if (typeof newStr !== 'string') {
    return { ok: false, output: 'Error: new_string must be a string (use "" to remove text)', summary: 'Missing or invalid new_string' };
  }

  const resolved = assertPathInside(root, target);
  if (!fs.existsSync(resolved)) {
    return { ok: false, output: `Error: File not found: ${target}`, summary: `File not found: ${target}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return { ok: false, output: `Error: ${target} is not a regular file`, summary: `${target} is not a regular file` };
  }
  if (stat.size > MAX_EDIT_FILE_BYTES) return oversizedEditResult(target);

  const content = fs.readFileSync(resolved, 'utf8');
  const count = content.split(oldStr).length - 1;

  if (count === 0) {
    return {
      ok: false,
      output: `Error: old_string not found in ${target}`,
      summary: `old_string not found in ${target}`,
    };
  }
  if (count > 1) {
    return {
      ok: false,
      output: `Error: old_string appears ${count} times in ${target}. Must appear exactly once for exact replace.`,
      summary: `old_string not unique (${count} times) in ${target}`,
    };
  }

  // A string replacement expands $&, $$, $` and $'. A callback keeps model-supplied
  // code and template text literal, as the edit_file contract promises.
  const updated = content.replace(oldStr, () => newStr);
  fs.writeFileSync(resolved, updated, 'utf8');

  const summary = `Edited ${target}`;
  return { ok: true, output: `Successfully edited ${target}`, summary: makeSummary(summary) };
}

async function handleListDir(args, root) {
  const target = args.path || args.dir_path || '.';
  const resolved = assertPathInside(root, target);

  if (!fs.existsSync(resolved)) {
    return { ok: false, output: `Error: Directory not found: ${target}`, summary: `Not found: ${target}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { ok: false, output: `Error: ${target} is not a directory`, summary: `Not a directory: ${target}` };
  }

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines = entries.map((ent) => {
    const isDir = ent.isDirectory();
    const prefix = isDir ? '[DIR]' : ent.isSymbolicLink() ? '[LINK]' : ent.isFile() ? '[FILE]' : '[OTHER]';
    let sizeStr = '';
    if (ent.isFile()) {
      try {
        // statSync would follow a link outside root, disclosing target metadata.
        // lstatSync also handles a file replaced by a symlink after readdir.
        const s = fs.lstatSync(path.join(resolved, ent.name));
        if (s.isFile()) sizeStr = ` (${s.size} B)`;
      } catch {
        // ignore
      }
    }
    return `${prefix} ${ent.name}${sizeStr}`;
  });

  const output = truncateOutput(lines.join('\n') || '(empty directory)');
  const summary = `Listed ${entries.length} entries in ${target}`;
  return { ok: true, output, summary: makeSummary(summary) };
}

export async function searchFiles(args, root, signal) {
  const pattern = args.pattern;
  if (!pattern) {
    return { ok: false, output: 'Error: missing pattern parameter', summary: 'Missing pattern' };
  }
  const target = args.path || '.';
  const resolved = assertPathInside(root, target);

  if (!fs.existsSync(resolved)) {
    return { ok: false, output: `Error: Path not found: ${target}`, summary: `Path not found: ${target}` };
  }

  let regex;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return { ok: false, output: `Error: Invalid regular expression: ${err.message}`, summary: 'Invalid regex' };
  }

  const matches = [];
  const maxMatches = 1000;
  let stoppedAtLimit = false;
  const realRoot = fs.existsSync(root) ? fs.realpathSync(path.resolve(root)) : path.resolve(root);
  const checkCancelled = () => { if (signal?.aborted) throw new Error('Aborted'); };

  async function scanFile(file) {
    checkCancelled();
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const abort = () => input.destroy(new Error('Aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    const relPath = path.relative(root, file).split(path.sep).join('/');
    let lineNo = 0;
    try {
      for await (const line of lines) {
        checkCancelled();
        lineNo++;
        if (!regex.test(line)) continue;
        matches.push(`${relPath}:${lineNo}: ${line}`);
        if (matches.length >= maxMatches) {
          stoppedAtLimit = true;
          break;
        }
      }
    } catch (error) {
      if (signal?.aborted || !error?.code) throw error;
      // Unreadable files are skipped, as in the prior synchronous search.
    } finally {
      signal?.removeEventListener('abort', abort);
      lines.close();
      input.destroy();
    }
  }

  async function walk(currDir) {
    checkCancelled();
    let entries;
    try {
      entries = await fs.promises.readdir(currDir, { withFileTypes: true });
    } catch {
      checkCancelled();
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      checkCancelled();
      if (stoppedAtLimit) break;
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.moragent') continue;
      const full = path.join(currDir, ent.name);
      if (ent.isDirectory()) {
        let realCurr;
        try {
          realCurr = await fs.promises.realpath(full);
        } catch {
          checkCancelled();
          continue;
        }
        if (isOutside(path.relative(realRoot, realCurr))) continue;
        await walk(full);
      } else if (ent.isFile()) {
        await scanFile(full);
      }
    }
  }

  const stat = await fs.promises.stat(resolved);
  if (!stat.isDirectory() && !stat.isFile()) {
    return { ok: false, output: `Error: ${target} is not a regular file or directory`, summary: `${target} is not a regular file or directory` };
  }
  try {
    if (stat.isDirectory()) await walk(resolved);
    else await scanFile(resolved);
  } catch (error) {
    if (signal?.aborted) {
      const msg = t('Búsqueda cancelada.', 'Search cancelled.');
      return { ok: false, output: msg, summary: msg };
    }
    throw error;
  }

  const rawOutput = matches.length > 0 ? matches.join('\n') : `No matches found for "${pattern}"`;
  const limitNotice = stoppedAtLimit ? '\n... [search stopped after 1000 matches / búsqueda detenida tras 1000 coincidencias]' : '';
  const output = truncateOutput(rawOutput, MAX_OUTPUT_BYTES - Buffer.byteLength(limitNotice)) + limitNotice;
  const summary = `Found ${matches.length} matches for "${pattern}"`;
  return { ok: true, output, summary: makeSummary(summary) };
}

function runGrepWorker(args, root, signal) {
  const configured = Number(process.env.MORAGENT_GREP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_GREP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./grep-worker.js', import.meta.url), { workerData: { args, root, lang: getLang() }, execArgv: [] });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timeout;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const abort = () => {
      const msg = t('Búsqueda cancelada.', 'Search cancelled.');
      finish({ ok: false, output: msg, summary: msg });
    };
    worker.once('message', finish);
    worker.once('error', (error) => finish({ ok: false, output: `Error: ${error.message}`, summary: 'Search worker failed' }));
    worker.once('exit', (code) => finish({ ok: false, output: `Error: search worker exited (${code})`, summary: 'Search worker exited' }));
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      const msg = t(`Búsqueda excedió el límite de ${timeoutMs} ms.`, `Search timed out after ${timeoutMs} ms.`);
      finish({ ok: false, output: msg, summary: msg });
    }, timeoutMs);
    timeout.unref?.();
    if (signal?.aborted) abort();
  });
}

function runShell(command, root, signal) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'cmd.exe' : 'bash';
    const argv = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    let child;
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let cancelled = false;
    let timedOut = false;
    let settled = false;
    let forceTimer;
    let timeout;

    const capture = (chunk, stream) => {
      const bytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, MAX_CAPTURE_BYTES - bytes);
      const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk.subarray(0, remaining));
      if (stream === 'stdout') { stdout += text; stdoutBytes += chunk.length; }
      else { stderr += text; stderrBytes += chunk.length; }
    };
    const stop = () => {
      terminateTree(child);
      if (!isWin) {
        forceTimer = setTimeout(() => terminateTree(child, { force: true }), 1000);
        forceTimer.unref?.();
      }
    };
    const abort = () => { cancelled = true; stop(); };
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ code, stdout, stderr, cancelled, timedOut, error });
    };

    try {
      child = spawn(file, argv, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      });
    } catch (error) {
      finish(127, error);
      return;
    }
    child.stdout.on('data', (chunk) => capture(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => capture(chunk, 'stderr'));
    child.once('error', (error) => finish(127, error));
    child.once('close', (code) => finish(code ?? 1));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timeout = setTimeout(() => { timedOut = true; stop(); }, BASH_TIMEOUT_MS);
    timeout.unref?.();
  });
}

async function handleBash(args, root, autonomy, signal) {
  if (autonomy !== 'full') {
    return {
      ok: false,
      output: t('Rechazado: bash requiere autonomía "full" en los proveedores API; el shell no tiene sandbox.', 'Refused: bash requires "full" autonomy for API providers; the shell is not sandboxed.'),
      summary: 'Refused: bash requires full autonomy',
    };
  }

  const command = args.command;
  if (!command || typeof command !== 'string') {
    return { ok: false, output: 'Error: missing command parameter', summary: 'Missing command' };
  }

  const r = await runShell(command, root, signal);

  if (r.cancelled || r.timedOut) {
    const output = r.cancelled
      ? t('Comando cancelado.', 'Command cancelled.')
      : t('Comando excedió el límite de 120 segundos.', 'Command exceeded the 120-second limit.');
    return { ok: false, output, summary: output };
  }

  const raw = [r.stdout, r.stderr || r.error?.message].filter(Boolean).join('\n').trim();
  const output = truncateOutput(raw || `(Process exited with code ${r.code})`);
  const summary = makeSummary(`Exit ${r.code}: ${command.slice(0, 60)}`);
  return { ok: r.code === 0, output, summary };
}

export async function executeTool(name, args = {}, { root, autonomy = 'auto', signal, protectedOtherPaths = [] } = {}) {
  try {
    if (signal?.aborted) {
      const msg = t('Ejecución cancelada.', 'Run cancelled.');
      return { ok: false, output: msg, summary: msg };
    }
    if (['readonly', 'ask'].includes(autonomy) && (name === 'write_file' || name === 'edit_file' || name === 'bash')) {
      const msg = t(
        `Rechazado: la herramienta "${name}" no está permitida en modo de autonomía "${autonomy}"`,
        `Refused: tool "${name}" is not permitted in "${autonomy}" autonomy mode`
      );
      return {
        ok: false,
        output: msg,
        summary: makeSummary(`Refused in readonly: ${name}`),
      };
    }
    if (['write_file', 'edit_file'].includes(name) && protectedOtherPaths.length) {
      const target = assertPathInside(root, args.path || args.file_path);
      const relative = path.relative(fs.realpathSync(root), target).split(path.sep).join('/');
      if (protectedOtherPaths.includes(relative)) {
        const msg = t(
          `Rechazado: "${relative}" está asignado a otra tarea; completa sólo tu archivo.`,
          `Refused: "${relative}" belongs to another task; complete only your assigned file.`,
        );
        return { ok: false, code: 'TASK_SCOPE', output: msg, summary: msg };
      }
    }

    switch (name) {
      case 'read_file':
        return await handleReadFile(args, root, signal);
      case 'write_file':
        return await handleWriteFile(args, root);
      case 'edit_file':
        return await handleEditFile(args, root);
      case 'list_dir':
        return await handleListDir(args, root);
      case 'grep':
        return await runGrepWorker(args, root, signal);
      case 'bash':
        return await handleBash(args, root, autonomy, signal);
      default:
        return {
          ok: false,
          output: `Unknown tool: ${name}`,
          summary: makeSummary(`Unknown tool: ${name}`),
        };
    }
  } catch (err) {
    const msg = err instanceof MoragentError ? err.message : String(err.message || err);
    return {
      ok: false,
      output: `Error: ${msg}`,
      summary: makeSummary(`Error: ${msg}`),
    };
  }
}
