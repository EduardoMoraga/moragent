import fs from 'node:fs';
import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { ensureDir, exists, readText, writeText, readJSON, today, nowISO } from '../core/fsx.js';
import { loadConfig } from '../core/config.js';
import { t, setLang, getLang } from '../core/i18n.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';

// Secret redaction patterns for API keys, tokens, and private keys
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_\-]{20,}/g,
  /gh[pousr]_[a-zA-Z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /xox[baprs]-[a-zA-Z0-9\-]{10,}/g,
  /-----BEGIN [A-Z0-9_ ]+ KEY-----[\s\S]*?-----END [A-Z0-9_ ]+ KEY-----/g,
  /(?:Bearer\s+)[a-zA-Z0-9_\-\.]{25,}/gi,
];

export function redactSecrets(text) {
  if (!text || typeof text !== 'string') return '';
  let clean = text;
  for (const pattern of SECRET_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED_SECRET]');
  }
  return clean;
}

function resolveRealPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent && parent !== p) {
      const realParent = resolveRealPath(parent);
      return path.join(realParent, path.basename(p));
    }
    return p;
  }
}

/**
 * Classifies a file path as inside or outside project root.
 * Inside files return { inside: true, relPath: 'path/to/file' }.
 * Outside files return { inside: false, path: '...' }.
 */
export function classifyFilePath(filePath, rootDir) {
  if (!filePath || typeof filePath !== 'string') return null;

  const normRoot = path.resolve(rootDir);
  const realRoot = resolveRealPath(normRoot);

  const absPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(rootDir, filePath);

  const realAbs = resolveRealPath(absPath);

  let rel = path.relative(realRoot, realAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    rel = path.relative(normRoot, absPath);
  }

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { inside: false, path: filePath };
  }

  return { inside: true, relPath: rel.replace(/^\.\//, '') };
}

/**
 * Extracts task IDs (T-XXXX) and spec slugs from text for Obsidian links.
 * Explicitly excludes file paths to avoid creating broken nodes in Obsidian.
 */
export function extractLinks(text) {
  if (!text || typeof text !== 'string') return [];
  const links = new Set();

  // 1. Task IDs: T-0001, T-0002, etc. (at least 4 digits)
  const taskMatches = text.match(/\bT-\d{4,}\b/gi) || [];
  for (const tm of taskMatches) {
    links.add(tm.toUpperCase());
  }

  // 2. Spec slugs: .moragent/specs/<slug> or specs/<slug>
  const specMatches = text.match(/(?:\.moragent\/specs\/|specs\/)([a-zA-Z0-9_\-]+)/g) || [];
  for (const sm of specMatches) {
    const slug = sm
      .replace(/^(?:\.moragent\/specs\/|specs\/)/, '')
      .replace(/\.md$/, '')
      .replace(/\.json$/, '');
    if (slug) {
      links.add(slug);
    }
  }

  return Array.from(links);
}

/**
 * Extracts turns, file changes, and bash commands from a Claude Code JSONL transcript.
 */
export function parseClaudeTranscript(transcriptPath) {
  if (!transcriptPath || !exists(transcriptPath)) {
    return { userPrompts: [], assistantMessages: [], filesTouched: [], bashCommands: [] };
  }

  const raw = readText(transcriptPath, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const userPrompts = [];
  const assistantMessages = [];
  const filesTouched = new Set();
  const bashCommands = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Tolerant to partial/corrupted lines
    }

    // 1. User prompts: supports strings, arrays of text blocks, and nested message
    if (entry.type === 'user' || entry.role === 'user' || entry.source === 'USER_INPUT') {
      let promptText = '';
      if (typeof entry.content === 'string') {
        promptText = entry.content;
      } else if (typeof entry.message?.content === 'string') {
        promptText = entry.message.content;
      } else if (Array.isArray(entry.message?.content)) {
        promptText = entry.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join('\n');
      } else if (Array.isArray(entry.content)) {
        promptText = entry.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join('\n');
      } else if (typeof entry.text === 'string') {
        promptText = entry.text;
      }

      if (promptText && promptText.trim()) {
        userPrompts.push(promptText.trim());
      }
    }

    // 2. Assistant messages & tool calls
    if (entry.type === 'assistant' || entry.role === 'assistant' || entry.source === 'MODEL' || entry.type === 'PLANNER_RESPONSE') {
      const contentBlocks = Array.isArray(entry.message?.content)
        ? entry.message.content
        : Array.isArray(entry.content)
          ? entry.content
          : [];

      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          assistantMessages.push(block.text.trim());
        } else if (block.type === 'tool_use' || block.tool_calls) {
          const name = block.name || block.tool_name;
          const input = block.input || {};

          // Files edited or written
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
            const fPath = input.file_path || input.filePath || input.path || input.target_file || input.TargetFile;
            if (fPath && typeof fPath === 'string') {
              filesTouched.add(fPath);
            }
          }

          // Bash commands
          if (['Bash', 'bash', 'terminal', 'run_command'].includes(name) && bashCommands.length < 5) {
            const cmd = input.command || input.cmd || input.CommandLine;
            if (cmd && typeof cmd === 'string') {
              bashCommands.push(cmd.trim());
            }
          }
        }
      }

      if (typeof entry.message?.content === 'string' && entry.message.content.trim()) {
        assistantMessages.push(entry.message.content.trim());
      }
      if (typeof entry.content === 'string' && entry.content.trim()) {
        assistantMessages.push(entry.content.trim());
      }
    }
  }

  return {
    userPrompts,
    assistantMessages,
    filesTouched: Array.from(filesTouched),
    bashCommands,
  };
}

/**
 * Capture episodic memory from Claude Code SessionEnd or Stop hook.
 */
export function captureClaude(hookPayload, { root } = {}) {
  const r = root || requireRoot();
  const data = typeof hookPayload === 'string' ? JSON.parse(hookPayload) : hookPayload || {};

  const sessionId = data.session_id || data.sessionId || 'unknown';
  const transcriptPath = data.transcript_path || data.transcriptPath;

  const { userPrompts, assistantMessages, filesTouched, bashCommands } = parseClaudeTranscript(transcriptPath);

  // Trivial session check: < 2 user turns AND 0 files touched -> skip
  if (userPrompts.length < 2 && filesTouched.length === 0) {
    return null;
  }

  // Set bilingual language from project config
  let lang = 'en';
  try {
    const cfg = loadConfig(r);
    if (cfg?.lang) lang = cfg.lang;
  } catch {
    lang = getLang() || 'en';
  }
  setLang(lang);

  // 1. Determine title: check if first prompt is a MORAGENT task envelope
  const rawTitle = userPrompts[0] || 'Claude session';
  const firstLineTitle = rawTitle.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || rawTitle;

  let cleanTitle = redactSecrets(firstLineTitle).slice(0, 80);
  let detectedTaskId = null;

  const envelopeMatch = firstLineTitle.match(/(?:Lee y ejecuta|Read and execute|\.moragent\/tasks\/|tasks\/)\s*.*?([Tt]-\d{4})/i)
    || firstLineTitle.match(/\b([Tt]-\d{4})\b/i);

  if (envelopeMatch) {
    detectedTaskId = envelopeMatch[1].toUpperCase();
    const taskJsonPath = path.join(dirs(r).tasks, `${detectedTaskId}.json`);
    if (exists(taskJsonPath)) {
      const taskData = readJSON(taskJsonPath, null);
      if (taskData?.title) {
        cleanTitle = redactSecrets(taskData.title).slice(0, 80);
      }
    }
  }

  // 2. Extract links: ONLY task IDs and spec slugs (NO file paths!)
  const allText = [
    ...userPrompts,
    ...assistantMessages,
    ...bashCommands,
  ].join('\n');
  const detectedLinks = extractLinks(allText);
  if (detectedTaskId && !detectedLinks.includes(detectedTaskId)) {
    detectedLinks.unshift(detectedTaskId);
  }

  // 3. Classify files touched: inside root -> relative; outside root -> count
  const insideFiles = [];
  let outsideFilesCount = 0;
  for (const f of filesTouched) {
    const res = classifyFilePath(f, r);
    if (res?.inside) {
      if (!insideFiles.includes(res.relPath)) {
        insideFiles.push(res.relPath);
      }
    } else {
      outsideFilesCount++;
    }
  }

  // 4. Last assistant message as summary (<= 600 chars)
  const lastAssistantText = assistantMessages.at(-1) || '';
  const cleanSummary = redactSecrets(lastAssistantText).slice(0, 600);

  // 5. Build stable note ID and path
  const cleanSessionId = String(sessionId).replace(/[^a-zA-Z0-9]/g, '');
  const shortId = cleanSessionId.slice(0, 8) || 'session';
  const noteId = `session-${today()}-${shortId}`;
  const d = dirs(r);
  ensureDir(d.episodic);
  const notePath = path.join(d.episodic, `${noteId}.md`);

  let existingData = {};
  if (exists(notePath)) {
    const parsed = parseFrontmatter(readText(notePath));
    existingData = parsed.data || {};
  }

  if (Array.isArray(existingData.links)) {
    for (const l of existingData.links) {
      if (!l.includes('/') && !l.includes('\\') && !detectedLinks.includes(l)) {
        detectedLinks.push(l);
      }
    }
  }

  const frontmatterData = {
    ...existingData,
    id: noteId,
    tier: 'episodic',
    kind: 'episode',
    title: cleanTitle,
    tags: ['session', 'claude'],
    links: detectedLinks,
    by: process.env.MORAGENT_ROLE || 'claude',
    sessionId: String(sessionId),
    created: existingData.created || nowISO(),
    updated: nowISO(),
  };

  // 6. Bilingual body
  const bodyParts = [
    t('## Resumen', '## Summary'),
    cleanSummary || t('_Sin resumen del asistente disponible._', '_No assistant summary available._'),
  ];

  if (insideFiles.length > 0 || outsideFilesCount > 0) {
    bodyParts.push('');
    bodyParts.push(t('## Archivos tocados', '## Files Touched'));
    for (const f of insideFiles) {
      bodyParts.push(`- \`${f}\``);
    }
    if (outsideFilesCount > 0) {
      const msg = t(
        `_(${outsideFilesCount} archivo${outsideFilesCount === 1 ? '' : 's'} fuera del proyecto)_`,
        `_(${outsideFilesCount} file${outsideFilesCount === 1 ? '' : 's'} outside project)_`
      );
      bodyParts.push(`- ${msg}`);
    }
  }

  if (bashCommands.length > 0) {
    bodyParts.push('');
    bodyParts.push(t('## Comandos', '## Commands'));
    for (const cmd of bashCommands.slice(0, 5)) {
      bodyParts.push(`- \`${redactSecrets(cmd)}\``);
    }
  }

  const content = stringifyFrontmatter(frontmatterData, bodyParts.join('\n'));
  writeText(notePath, content);

  return {
    id: noteId,
    path: notePath,
    note: { ...frontmatterData, body: bodyParts.join('\n'), path: notePath },
  };
}

/**
 * Capture episodic memory from Codex turn-complete notify notification.
 */
export function captureCodex(notifyPayload, { root } = {}) {
  const r = root || requireRoot();
  const data = typeof notifyPayload === 'string' ? JSON.parse(notifyPayload) : notifyPayload || {};

  const threadId = data['thread-id'] || data.thread_id || data['turn-id'] || data.turn_id || 'codex';
  const shortId = String(threadId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'codex';
  const noteId = `session-${today()}-${shortId}`;

  const d = dirs(r);
  ensureDir(d.episodic);
  const notePath = path.join(d.episodic, `${noteId}.md`);

  const inputMessages = data['input-messages'] || data.input_messages || [];
  const lastAssistant = data['last-assistant-message'] ?? data.last_assistant_message ?? '';

  let lang = 'en';
  try {
    const cfg = loadConfig(r);
    if (cfg?.lang) lang = cfg.lang;
  } catch {
    lang = getLang() || 'en';
  }
  setLang(lang);

  let rawTitle = 'Codex session';
  if (Array.isArray(inputMessages) && inputMessages.length > 0) {
    const first = inputMessages[0];
    if (typeof first === 'string') {
      rawTitle = first;
    } else if (first && typeof first === 'object') {
      rawTitle = first.content || first.text || 'Codex session';
    }
  } else if (typeof inputMessages === 'string') {
    rawTitle = inputMessages;
  }

  const firstLine = rawTitle.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || rawTitle;

  let cleanTitle = redactSecrets(firstLine).slice(0, 80);
  let detectedTaskId = null;
  const envelopeMatch = firstLine.match(/(?:Lee y ejecuta|Read and execute|\.moragent\/tasks\/|tasks\/)\s*.*?([Tt]-\d{4})/i)
    || firstLine.match(/\b([Tt]-\d{4})\b/i);

  if (envelopeMatch) {
    detectedTaskId = envelopeMatch[1].toUpperCase();
    const taskJsonPath = path.join(dirs(r).tasks, `${detectedTaskId}.json`);
    if (exists(taskJsonPath)) {
      const taskData = readJSON(taskJsonPath, null);
      if (taskData?.title) {
        cleanTitle = redactSecrets(taskData.title).slice(0, 80);
      }
    }
  }

  const lastAssistantStr = typeof lastAssistant === 'string'
    ? lastAssistant
    : (lastAssistant?.content || lastAssistant?.text || JSON.stringify(lastAssistant) || '');
  const cleanLastAssistant = redactSecrets(lastAssistantStr).slice(0, 600);

  const detectedLinks = extractLinks(`${rawTitle}\n${lastAssistantStr}`);
  if (detectedTaskId && !detectedLinks.includes(detectedTaskId)) {
    detectedLinks.unshift(detectedTaskId);
  }

  // Check if note already exists to accumulate turns (max 5)
  const rawTurnList = [];
  let existingData = {};
  if (exists(notePath)) {
    const parsed = parseFrontmatter(readText(notePath));
    existingData = parsed.data || {};
    const existingBody = parsed.body || '';
    const regex = /^### Turn(?:o)? \d+:\s*([^\n]+)\n([\s\S]*?)(?=(?:^### Turn(?:o)? \d+:|$))/gm;
    const matches = [...existingBody.matchAll(regex)];
    for (const m of matches) {
      rawTurnList.push({
        user: m[1].trim(),
        assistant: m[2].trim(),
      });
    }
    if (Array.isArray(existingData.links)) {
      for (const l of existingData.links) {
        if (!l.includes('/') && !l.includes('\\') && !detectedLinks.includes(l)) {
          detectedLinks.push(l);
        }
      }
    }
  }

  const turnDefaultMsg = t('_Turno completado._', '_Completed turn._');
  rawTurnList.push({
    user: redactSecrets(firstLine.slice(0, 140)),
    assistant: cleanLastAssistant || turnDefaultMsg,
  });

  const recentTurns = rawTurnList.slice(-5);
  const turnLabel = t('Turno', 'Turn');
  const turnBlocks = recentTurns.map((tItem, idx) => `### ${turnLabel} ${idx + 1}: ${tItem.user}\n${tItem.assistant}`);

  const frontmatterData = {
    ...existingData,
    id: noteId,
    tier: 'episodic',
    kind: 'episode',
    title: existingData.title || cleanTitle,
    tags: ['session', 'codex'],
    links: detectedLinks,
    by: process.env.MORAGENT_ROLE || 'codex',
    threadId: String(threadId),
    created: existingData.created || nowISO(),
    updated: nowISO(),
  };

  const body = `${t('## Turnos', '## Turns')}\n\n${turnBlocks.join('\n\n')}`;
  const content = stringifyFrontmatter(frontmatterData, body);
  writeText(notePath, content);

  return {
    id: noteId,
    path: notePath,
    note: { ...frontmatterData, body, path: notePath },
  };
}

/**
 * Hook configurations to be installed during sync.
 */
export function hookConfig() {
  return {
    claude: {
      file: '.claude/settings.json',
      config: {
        hooks: {
          SessionEnd: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'mora memory capture --from claude',
                },
              ],
            },
          ],
        },
      },
    },
    codex: {
      file: '.codex/config.toml',
      toml: 'notify = ["mora", "memory", "capture", "--from", "codex"]\n',
    },
  };
}
