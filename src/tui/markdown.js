import { plain, c as defaultColors } from '../core/log.js';

// Style words individually so ANSI escape sequences do not leak across wrapped lines
function styleWords(text, styleFn) {
  if (!text) return '';
  return text
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : styleFn(part)))
    .join('');
}

// Slice string by visible character count, ignoring ANSI escape sequences
function sliceAnsi(str, maxVisible) {
  let visible = 0;
  let result = '';
  let inEscape = false;
  let hadEscape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\x1b') {
      inEscape = true;
      hadEscape = true;
      result += ch;
      continue;
    }
    if (inEscape) {
      result += ch;
      if (ch === 'm') inEscape = false;
      continue;
    }
    if (visible >= maxVisible) break;
    result += ch;
    visible++;
  }
  return hadEscape ? result + '\x1b[0m' : result;
}

function sliceAnsiFrom(str, fromVisible) {
  let visible = 0;
  let result = '';
  let activeStyles = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\x1b') {
      let esc = ch;
      while (i + 1 < str.length && str[i + 1] !== 'm') {
        i++;
        esc += str[i];
      }
      if (i + 1 < str.length && str[i + 1] === 'm') {
        i++;
        esc += str[i];
      }
      if (visible < fromVisible) {
        activeStyles += esc;
      } else {
        result += esc;
      }
      continue;
    }
    if (visible >= fromVisible) {
      result += ch;
    }
    visible++;
  }
  return activeStyles + result;
}

export function formatInline(text, colors) {
  if (!text) return '';
  let s = String(text);

  // 1. Links: [text](url) -> text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 2. Inline code: `code`
  s = s.replace(/`([^`\n]+)`/g, (_, code) => styleWords(code, colors.cyan));

  // 3. Bold: **bold** or __bold__
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, b) => styleWords(b, colors.bold));
  s = s.replace(/__([^_]+)__/g, (_, b) => styleWords(b, colors.bold));

  // 4. Italic: *italic* or _italic_
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, it) => styleWords(it, colors.italic));
  s = s.replace(/(?<![a-zA-Z0-9_])_([^_]+)_(?![a-zA-Z0-9_])/g, (_, it) => styleWords(it, colors.italic));

  return s;
}

function wrapLineWithIndent(text, firstPrefix, contPrefix, max) {
  const firstPrefixLen = plain(firstPrefix).length;
  const contPrefixLen = plain(contPrefix).length;
  const firstMax = Math.max(1, max - firstPrefixLen);
  const contMax = Math.max(1, max - contPrefixLen);

  if (!text || text.trim() === '') {
    return [firstPrefix.trimEnd()];
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [firstPrefix.trimEnd()];
  }

  const lines = [];
  let currentWords = [];
  let currentLen = 0;
  let isFirstLine = true;

  for (const token of tokens) {
    const currentLimit = isFirstLine ? firstMax : contMax;
    const tokenLen = plain(token).length;

    // Single token is wider than the allowed column limit: hard split it
    if (tokenLen > currentLimit) {
      if (currentWords.length > 0) {
        const prefix = isFirstLine ? firstPrefix : contPrefix;
        lines.push(prefix + currentWords.join(' '));
        currentWords = [];
        currentLen = 0;
        isFirstLine = false;
      }

      let rem = token;
      while (plain(rem).length > (isFirstLine ? firstMax : contMax)) {
        const limit = isFirstLine ? firstMax : contMax;
        const chunk = sliceAnsi(rem, limit);
        const prefix = isFirstLine ? firstPrefix : contPrefix;
        lines.push(prefix + chunk);
        rem = sliceAnsiFrom(rem, limit);
        isFirstLine = false;
      }
      if (plain(rem).length > 0) {
        currentWords = [rem];
        currentLen = plain(rem).length;
      }
      continue;
    }

    const addedLen = currentWords.length === 0 ? tokenLen : currentLen + 1 + tokenLen;

    if (addedLen <= currentLimit) {
      currentWords.push(token);
      currentLen = addedLen;
    } else {
      const prefix = isFirstLine ? firstPrefix : contPrefix;
      lines.push(prefix + currentWords.join(' '));
      isFirstLine = false;
      currentWords = [token];
      currentLen = tokenLen;
    }
  }

  if (currentWords.length > 0) {
    const prefix = isFirstLine ? firstPrefix : contPrefix;
    lines.push(prefix + currentWords.join(' '));
  }

  return lines;
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  const current = lines[i].trim();
  const next = lines[i + 1].trim();
  if (!current.includes('|') || !next.includes('|')) return false;
  return /^\s*\|?\s*:?-{2,}:?\s*(\|?\s*:?-{2,}:?\s*)+\|?\s*$/.test(next);
}

function parseCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function renderTable(tableLines, max, colors) {
  if (tableLines.length < 2) return tableLines;
  const headerRaw = parseCells(tableLines[0]);
  const dataRowsRaw = tableLines.slice(2).map(parseCells);

  const numCols = headerRaw.length;
  if (numCols === 0) return [];

  const headers = headerRaw.map((h) => formatInline(h, colors));
  const rows = dataRowsRaw.map((row) => {
    const r = [];
    for (let c = 0; c < numCols; c++) {
      r.push(formatInline(row[c] || '', colors));
    }
    return r;
  });

  const colWidths = [];
  for (let c = 0; c < numCols; c++) {
    let w = plain(headers[c]).length;
    for (const r of rows) {
      w = Math.max(w, plain(r[c] || '').length);
    }
    colWidths.push(Math.max(1, w));
  }

  const totalTableWidth = colWidths.reduce((a, b) => a + b, 0) + (numCols - 1) * 3;

  if (totalTableWidth <= max) {
    const out = [];

    const headerPadded = headers.map((h, c) => {
      const pad = colWidths[c] - plain(h).length;
      return h + ' '.repeat(Math.max(0, pad));
    });
    out.push(colors.bold(headerPadded.join(' │ ')));

    const sep = colWidths.map((w) => '─'.repeat(w)).join('─┼─');
    out.push(colors.dim(sep));

    for (const r of rows) {
      const rowPadded = r.map((cell, c) => {
        const pad = colWidths[c] - plain(cell).length;
        return cell + ' '.repeat(Math.max(0, pad));
      });
      out.push(rowPadded.join(' │ '));
    }

    return out;
  }

  // Degrade table to key-value rows when it does not fit horizontally
  const degraded = [];
  for (const r of rows) {
    const parts = [];
    for (let c = 0; c < numCols; c++) {
      const hText = plain(headers[c]).trim();
      const val = r[c] || '';
      if (hText) {
        parts.push(`${colors.bold(hText)}: ${val}`);
      } else {
        parts.push(val);
      }
    }
    const combined = parts.join(' · ');
    const wrapped = wrapLineWithIndent(combined, '• ', '  ', max);
    for (const l of wrapped) degraded.push(l);
  }

  return degraded;
}

export function renderMarkdown(text, maxWidth = 80, { c = defaultColors } = {}) {
  if (text == null) return [];
  const str = String(text).normalize('NFC');
  if (str === '') return [''];

  const max = Math.max(1, maxWidth | 0);
  const colors = {
    bold: c?.bold || ((s) => s),
    italic: c?.italic || ((s) => s),
    dim: c?.dim || ((s) => s),
    cyan: c?.cyan || c?.dim || ((s) => s),
    brand: c?.brand || c?.bold || ((s) => s),
    gray: c?.gray || c?.dim || ((s) => s),
  };

  const rawLines = str.split('\n');
  const out = [];

  let inCodeBlock = false;
  let i = 0;

  while (i < rawLines.length) {
    const rawLine = rawLines[i];

    // Check code block fence
    const fenceMatch = rawLine.match(/^\s*```([a-zA-Z0-9_-]*)/);
    if (fenceMatch) {
      inCodeBlock = !inCodeBlock;
      i++;
      continue;
    }

    if (inCodeBlock) {
      // Code blocks: dimmed, no word reflow, cut/wrap hard at max
      if (rawLine === '') {
        out.push('');
      } else {
        let rem = rawLine;
        while (plain(rem).length > max) {
          const chunk = rem.slice(0, max);
          out.push(colors.dim(chunk));
          rem = rem.slice(max);
        }
        if (rem.length > 0) {
          out.push(colors.dim(rem));
        }
      }
      i++;
      continue;
    }

    // Check tables
    if (isTableStart(rawLines, i)) {
      const tableLines = [];
      while (i < rawLines.length && rawLines[i].includes('|') && rawLines[i].trim() !== '') {
        tableLines.push(rawLines[i]);
        i++;
      }
      const renderedTable = renderTable(tableLines, max, colors);
      for (const tl of renderedTable) {
        out.push(tl);
      }
      continue;
    }

    // Blank line
    if (rawLine.trim() === '') {
      out.push('');
      i++;
      continue;
    }

    // Headings: # Heading
    const headingMatch = rawLine.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const hashes = headingMatch[1];
      const title = formatInline(headingMatch[2].trim(), colors);
      const prefix = hashes + ' ';
      const wrapped = wrapLineWithIndent(title, colors.bold(prefix), ' '.repeat(prefix.length), max);
      for (const l of wrapped) {
        out.push(colors.bold(l));
      }
      i++;
      continue;
    }

    // Bullet list: - item or * item
    const bulletMatch = rawLine.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
      const leadingSpaces = bulletMatch[1].length;
      const bulletIndent = ' '.repeat(leadingSpaces) + '• ';
      const hangingIndent = ' '.repeat(bulletIndent.length);
      const content = formatInline(bulletMatch[3], colors);
      const wrapped = wrapLineWithIndent(content, bulletIndent, hangingIndent, max);
      for (const l of wrapped) out.push(l);
      i++;
      continue;
    }

    // Numbered list: 1. item
    const numMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numMatch) {
      const leadingSpaces = numMatch[1].length;
      const numPrefix = ' '.repeat(leadingSpaces) + numMatch[2] + '. ';
      const hangingIndent = ' '.repeat(numPrefix.length);
      const content = formatInline(numMatch[3], colors);
      const wrapped = wrapLineWithIndent(content, numPrefix, hangingIndent, max);
      for (const l of wrapped) out.push(l);
      i++;
      continue;
    }

    // Blockquote: > quote
    const quoteMatch = rawLine.match(/^(\s*)>\s?(.*)$/);
    if (quoteMatch) {
      const prefix = '│ ';
      const content = formatInline(quoteMatch[2], colors);
      const wrapped = wrapLineWithIndent(content, colors.dim(prefix), colors.dim(prefix), max);
      for (const l of wrapped) out.push(l);
      i++;
      continue;
    }

    // Regular paragraph
    const formatted = formatInline(rawLine, colors);
    const wrapped = wrapLineWithIndent(formatted, '', '', max);
    for (const l of wrapped) out.push(l);
    i++;
  }

  const result = out.length ? out : [''];
  // Guarantee every line <= max
  return result.map((l) => (plain(l).length <= max ? l : sliceAnsi(l, max)));
}
