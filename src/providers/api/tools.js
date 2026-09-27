import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../core/exec.js';
import { MoragentError } from '../../core/errors.js';
import { t } from '../../core/i18n.js';

export const MAX_OUTPUT_BYTES = 20 * 1024; // 20 KB

export function truncateOutput(str, maxBytes = MAX_OUTPUT_BYTES) {
  if (typeof str !== 'string') str = String(str ?? '');
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  const notice = '\n... [output truncated to 20 KB / salida truncada a 20 KB]';
  const noticeBuf = Buffer.from(notice, 'utf8');
  const sliceLen = Math.max(0, maxBytes - noticeBuf.length);
  const cut = buf.subarray(0, sliceLen).toString('utf8');
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
  if (relLexical.startsWith('..') || path.isAbsolute(relLexical)) {
    throw new MoragentError('PATH_OUTSIDE_ROOT',
      t(`La ruta "${targetPath}" escapa de la raíz del proyecto`,
        `Path "${targetPath}" escapes the project root`));
  }

  // Symlink check: if target exists, resolve realpath
  if (fs.existsSync(targetResolved)) {
    const realTarget = fs.realpathSync(targetResolved);
    const relReal = path.relative(realRoot, realTarget);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new MoragentError('PATH_OUTSIDE_ROOT',
        t(`El enlace simbólico "${targetPath}" apunta fuera de la raíz`,
          `Symlink "${targetPath}" resolves outside the project root`));
    }
    return targetResolved;
  }

  // If target does not exist yet (e.g. write_file), check closest existing ancestor directory
  let curr = path.dirname(targetResolved);
  while (!fs.existsSync(curr)) {
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  if (fs.existsSync(curr)) {
    const realAncestor = fs.realpathSync(curr);
    const relAncestor = path.relative(realRoot, realAncestor);
    if (relAncestor.startsWith('..') || path.isAbsolute(relAncestor)) {
      throw new MoragentError('PATH_OUTSIDE_ROOT',
        t(`La ruta de destino "${targetPath}" está en un directorio que escapa de la raíz`,
          `Destination path "${targetPath}" is within a directory that escapes the project root`));
    }
  }

  return targetResolved;
}

function makeSummary(str, max = 200) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + '...';
}

// Canonical tool definitions
export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file within the project root.',
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
    description: 'Write content to a file within the project root. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file inside the project root' },
        content: { type: 'string', description: 'The text content to write to the file' },
      },
      required: ['path', 'content'],
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

export function filterToolsForAutonomy(autonomy) {
  if (autonomy === 'readonly') {
    return TOOL_DEFINITIONS.filter((t) => ['read_file', 'list_dir', 'grep'].includes(t.name));
  }
  return TOOL_DEFINITIONS;
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
async function handleReadFile(args, root) {
  const target = args.path || args.file_path;
  if (!target) {
    return { ok: false, output: 'Error: missing path parameter', summary: 'Missing path' };
  }
  const resolved = assertPathInside(root, target);
  if (!fs.existsSync(resolved)) {
    return { ok: false, output: `Error: File not found: ${target}`, summary: `File not found: ${target}` };
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { ok: false, output: `Error: ${target} is a directory, not a file`, summary: `${target} is a directory` };
  }

  let text = fs.readFileSync(resolved, 'utf8');
  const offset = Number.parseInt(args.offset, 10);
  const limit = Number.parseInt(args.limit, 10);

  if (!Number.isNaN(offset) || !Number.isNaN(limit)) {
    const lines = text.split('\n');
    const startIdx = !Number.isNaN(offset) && offset > 0 ? offset - 1 : 0;
    const endIdx = !Number.isNaN(limit) && limit > 0 ? startIdx + limit : lines.length;
    text = lines.slice(startIdx, endIdx).join('\n');
  }

  const output = truncateOutput(text);
  const summary = `Read ${target} (${Buffer.byteLength(text, 'utf8')} bytes)`;
  return { ok: true, output, summary: makeSummary(summary) };
}

async function handleWriteFile(args, root) {
  const target = args.path || args.file_path;
  if (!target) {
    return { ok: false, output: 'Error: missing path parameter', summary: 'Missing path' };
  }
  const content = String(args.content ?? '');
  const resolved = assertPathInside(root, target);

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');

  const bytes = Buffer.byteLength(content, 'utf8');
  const summary = `Wrote ${bytes} bytes to ${target}`;
  return { ok: true, output: `Successfully wrote ${bytes} bytes to ${target}`, summary: makeSummary(summary) };
}

async function handleEditFile(args, root) {
  const target = args.path || args.file_path;
  if (!target) {
    return { ok: false, output: 'Error: missing path parameter', summary: 'Missing path' };
  }
  const oldStr = args.old_string ?? args.old_str ?? args.find ?? args.target;
  const newStr = args.new_string ?? args.new_str ?? args.replace ?? '';
  if (oldStr === undefined || oldStr === null) {
    return { ok: false, output: 'Error: missing old_string parameter', summary: 'Missing old_string' };
  }

  const resolved = assertPathInside(root, target);
  if (!fs.existsSync(resolved)) {
    return { ok: false, output: `Error: File not found: ${target}`, summary: `File not found: ${target}` };
  }

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

  const updated = content.replace(oldStr, newStr);
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
    const prefix = isDir ? '[DIR] ' : '[FILE]';
    let sizeStr = '';
    if (!isDir) {
      try {
        const s = fs.statSync(path.join(resolved, ent.name));
        sizeStr = ` (${s.size} B)`;
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

async function handleGrep(args, root) {
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
  const realRoot = fs.existsSync(root) ? fs.realpathSync(path.resolve(root)) : path.resolve(root);

  function walk(currDir) {
    let entries;
    try {
      entries = fs.readdirSync(currDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.moragent') continue;
      const full = path.join(currDir, ent.name);
      if (ent.isDirectory()) {
        try {
          const realCurr = fs.realpathSync(full);
          const relReal = path.relative(realRoot, realCurr);
          if (relReal.startsWith('..') || path.isAbsolute(relReal)) continue;
          walk(full);
        } catch {
          // ignore
        }
      } else if (ent.isFile()) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          const relPath = path.relative(root, full).split(path.sep).join('/'); // models see forward slashes on every OS
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push(`${relPath}:${i + 1}: ${lines[i]}`);
              if (matches.length >= 1000) break;
            }
          }
        } catch {
          // Skip binary files or unreadable files
        }
      }
    }
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    walk(resolved);
  } else {
    try {
      const content = fs.readFileSync(resolved, 'utf8');
      const lines = content.split('\n');
      const relPath = path.relative(root, resolved).split(path.sep).join('/');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${relPath}:${i + 1}: ${lines[i]}`);
        }
      }
    } catch {
      // ignore
    }
  }

  const rawOutput = matches.length > 0 ? matches.join('\n') : `No matches found for "${pattern}"`;
  const output = truncateOutput(rawOutput);
  const summary = `Found ${matches.length} matches for "${pattern}"`;
  return { ok: true, output, summary: makeSummary(summary) };
}

async function handleBash(args, root, autonomy) {
  if (autonomy === 'ask') {
    return {
      ok: false,
      output: 'Refused: bash execution is not permitted in "ask" autonomy mode / Rechazado: ejecución de bash no permitida en modo de autonomía "ask"',
      summary: 'Refused: bash requires auto autonomy',
    };
  }

  const command = args.command;
  if (!command || typeof command !== 'string') {
    return { ok: false, output: 'Error: missing command parameter', summary: 'Missing command' };
  }

  const isWin = process.platform === 'win32';
  const r = isWin
    ? run('cmd.exe', ['/d', '/s', '/c', command], { cwd: root, timeoutMs: 120000 })
    : run('bash', ['-c', command], { cwd: root, timeoutMs: 120000 });

  const raw = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  const output = truncateOutput(raw || `(Process exited with code ${r.code})`);
  const summary = makeSummary(`Exit ${r.code}: ${command.slice(0, 60)}`);
  return { ok: r.code === 0, output, summary };
}

export async function executeTool(name, args = {}, { root, autonomy = 'auto' } = {}) {
  try {
    if (autonomy === 'readonly' && (name === 'write_file' || name === 'edit_file' || name === 'bash')) {
      const msg = t(
        `Rechazado: la herramienta "${name}" no está permitida en modo de autonomía "readonly"`,
        `Refused: tool "${name}" is not permitted in "readonly" autonomy mode`
      );
      return {
        ok: false,
        output: msg,
        summary: makeSummary(`Refused in readonly: ${name}`),
      };
    }

    switch (name) {
      case 'read_file':
        return await handleReadFile(args, root);
      case 'write_file':
        return await handleWriteFile(args, root);
      case 'edit_file':
        return await handleEditFile(args, root);
      case 'list_dir':
        return await handleListDir(args, root);
      case 'grep':
        return await handleGrep(args, root);
      case 'bash':
        return await handleBash(args, root, autonomy);
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
