import fs from 'node:fs';
import path from 'node:path';
import { dirs, requireRoot } from '../core/paths.js';
import { ensureDir, exists, readText, writeText, today, nowISO } from '../core/fsx.js';
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

    // 1. User prompts
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
            const fPath = input.file_path || input.filePath || input.path || input.target_file;
            if (fPath && typeof fPath === 'string') {
              filesTouched.add(fPath);
            }
          }

          // Bash commands
          if (['Bash', 'bash', 'terminal'].includes(name) && bashCommands.length < 5) {
            const cmd = input.command || input.cmd;
            if (cmd && typeof cmd === 'string') {
              bashCommands.push(cmd.trim());
            }
          }
        }
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
  const cwd = data.cwd || r;

  const { userPrompts, assistantMessages, filesTouched, bashCommands } = parseClaudeTranscript(transcriptPath);

  // Trivial session check: < 2 user turns AND 0 files touched -> skip
  if (userPrompts.length < 2 && filesTouched.length === 0) {
    return null;
  }

  // First user prompt as title (<= 80 chars)
  const rawTitle = userPrompts[0] || 'Claude session';
  const firstLineTitle = rawTitle.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || rawTitle;
  const cleanTitle = redactSecrets(firstLineTitle).slice(0, 80);

  // Last assistant message as summary (<= 600 chars)
  const lastAssistantText = assistantMessages.at(-1) || '';
  const cleanSummary = redactSecrets(lastAssistantText).slice(0, 600);

  // Relativize files to project root
  const realR = (() => { try { return fs.realpathSync(r); } catch { return r; } })();
  const relFiles = Array.from(new Set(filesTouched.map((f) => {
    if (!path.isAbsolute(f)) {
      return path.normalize(f).replace(/^\.\//, '');
    }
    const realF = (() => { try { return fs.realpathSync(f); } catch { return f; } })();
    let rel = path.relative(r, f);
    if (rel.startsWith('..')) {
      const realRel = path.relative(realR, realF);
      if (!realRel.startsWith('..')) rel = realRel;
    }
    return rel;
  })));

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

  const frontmatterData = {
    ...existingData,
    id: noteId,
    tier: 'episodic',
    kind: 'episode',
    title: cleanTitle,
    tags: ['session', 'claude'],
    links: relFiles.slice(0, 5),
    by: process.env.MORAGENT_ROLE || 'claude',
    sessionId: String(sessionId),
    created: existingData.created || nowISO(),
    updated: nowISO(),
  };

  const bodyParts = [
    '## Summary',
    cleanSummary || '_No assistant summary available._',
  ];

  if (relFiles.length > 0) {
    bodyParts.push('');
    bodyParts.push('## Files Touched');
    for (const f of relFiles) {
      bodyParts.push(`- \`${f}\``);
    }
  }

  if (bashCommands.length > 0) {
    bodyParts.push('');
    bodyParts.push('## Commands Run');
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
  const cleanTitle = redactSecrets(firstLine).slice(0, 80);

  const lastAssistantStr = typeof lastAssistant === 'string'
    ? lastAssistant
    : (lastAssistant?.content || lastAssistant?.text || JSON.stringify(lastAssistant) || '');
  const cleanLastAssistant = redactSecrets(lastAssistantStr).slice(0, 600);

  // Check if note already exists to accumulate turns (max 5)
  const rawTurnList = [];
  let existingData = {};
  if (exists(notePath)) {
    const parsed = parseFrontmatter(readText(notePath));
    existingData = parsed.data || {};
    const existingBody = parsed.body || '';
    const regex = /^### Turn \d+:\s*([^\n]+)\n([\s\S]*?)(?=(?:^### Turn \d+:|$))/gm;
    const matches = [...existingBody.matchAll(regex)];
    for (const m of matches) {
      rawTurnList.push({
        user: m[1].trim(),
        assistant: m[2].trim(),
      });
    }
  }

  rawTurnList.push({
    user: redactSecrets(firstLine.slice(0, 140)),
    assistant: cleanLastAssistant || '_Completed turn._',
  });

  const recentTurns = rawTurnList.slice(-5);
  const turnBlocks = recentTurns.map((t, idx) => `### Turn ${idx + 1}: ${t.user}\n${t.assistant}`);

  const frontmatterData = {
    ...existingData,
    id: noteId,
    tier: 'episodic',
    kind: 'episode',
    title: existingData.title || cleanTitle,
    tags: ['session', 'codex'],
    by: process.env.MORAGENT_ROLE || 'codex',
    threadId: String(threadId),
    created: existingData.created || nowISO(),
    updated: nowISO(),
  };

  const body = `## Turns\n\n${turnBlocks.join('\n\n')}`;
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
