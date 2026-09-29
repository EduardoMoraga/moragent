import { t } from '../core/i18n.js';
import { StringDecoder } from 'node:string_decoder';

export const SLASH_COMMANDS = ['/login', '/plan', '/equipo', '/orquestador', '/modelo', '/memoria', '/abrir', '/agentes', '/sesiones', '/sesion', '/limpiar', '/nuevo', '/cancel', '/help', '/salir'];

export function decodeKey(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s === '\r' || s === '\n') return { name: 'enter' };
  if (s === '\u0003') return { name: 'ctrl-c' };
  if (s === '\u0002') return { name: 'ctrl-b' };
  if (s === '\u001b') return { name: 'escape' };
  if (s === '\t') return { name: 'tab' };
  if (s === '\u007f' || s === '\b') return { name: 'backspace' };
  if (s === '\u001b[A') return { name: 'up' };
  if (s === '\u001b[B') return { name: 'down' };
  if (s === '\u001b[1;2A') return { name: 'shift-up' };
  if (s === '\u001b[1;2B') return { name: 'shift-down' };
  if (s === '\u001b[C') return { name: 'right' };
  if (s === '\u001b[D') return { name: 'left' };
  if (s === '\u001b[H' || s === '\u001bOH') return { name: 'home' };
  if (s === '\u001b[F' || s === '\u001bOF') return { name: 'end' };
  if (s === '\u001b[5~') return { name: 'pageup' };
  if (s === '\u001b[6~') return { name: 'pagedown' };
  const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([mM])$/.exec(s);
  if (mouse) {
    const code = Number(mouse[1]);
    if (code === 64) return { name: 'wheel-up' };
    if (code === 65) return { name: 'wheel-down' };
    return { name: 'mouse', code, x: Number(mouse[2]), y: Number(mouse[3]), up: mouse[4] === 'm' };
  }
  if (s === '\u001bb' || s === '\u001b[1;5D') return { name: 'word-left' };
  if (s === '\u001bf' || s === '\u001b[1;5C') return { name: 'word-right' };
  if (s >= ' ' && s !== '\u007f') return { name: 'text', value: s };
  return { name: 'unknown', raw: s };
}

export function decodeKeys(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const out = [];
  const escapes = ['\u001b[1;5D', '\u001b[1;5C', '\u001b[1;2A', '\u001b[1;2B', '\u001b[5~', '\u001b[6~', '\u001b[A', '\u001b[B', '\u001b[C', '\u001b[D', '\u001b[H', '\u001b[F', '\u001bOH', '\u001bOF', '\u001bb', '\u001bf'];
  for (let i = 0; i < s.length;) {
    if (s[i] === '\u001b') {
      const rest = s.slice(i);
      const mouse = /^\u001b\[<\d+;\d+;\d+[mM]/.exec(rest)?.[0];
      const sequence = mouse || escapes.find((candidate) => rest.startsWith(candidate));
      if (sequence) { out.push(decodeKey(sequence)); i += sequence.length; continue; }
      const unknown = /^\u001b\[[0-9;]*[A-Za-z~]/.exec(rest)?.[0];
      if (unknown) { out.push(decodeKey(unknown)); i += unknown.length; continue; }
    }
    const codePoint = s.codePointAt(i);
    const ch = String.fromCodePoint(codePoint);
    out.push(decodeKey(ch));
    i += ch.length;
  }
  return out;
}

// Raw TTY `data` events are byte chunks, not keystrokes. Keep incomplete UTF-8
// bytes and CSI sequences until the next chunk; a lone Esc can be flushed by the UI.
export class TerminalKeyDecoder {
  constructor() {
    this.utf8 = new StringDecoder('utf8');
    this.pending = '';
    this.paste = null;
  }
  get hasPendingEscape() {
    const start = '\x1b[200~';
    return this.paste === null && this.pending.length > 0 && (this.pending === '\x1b' || !start.startsWith(this.pending));
  }
  push(chunk) {
    this.pending += typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    return this.drain();
  }
  drain(force = false) {
    const start = '\x1b[200~';
    const end = '\x1b[201~';
    const out = [];
    while (this.pending) {
      if (this.paste !== null) {
        const close = this.pending.indexOf(end);
        if (close >= 0) {
          this.paste += this.pending.slice(0, close);
          this.pending = this.pending.slice(close + end.length);
          out.push({ name: 'paste', value: this.paste });
          this.paste = null;
          continue;
        }
        let hold = 0;
        for (let n = Math.min(end.length - 1, this.pending.length); n > 0; n--) {
          if (end.startsWith(this.pending.slice(-n))) { hold = n; break; }
        }
        this.paste += this.pending.slice(0, this.pending.length - hold);
        this.pending = hold ? this.pending.slice(-hold) : '';
        break;
      }
      const open = this.pending.indexOf(start);
      if (open >= 0) {
        out.push(...decodeKeys(this.pending.slice(0, open)));
        this.pending = this.pending.slice(open + start.length);
        this.paste = '';
        continue;
      }
      let hold = 0;
      if (!force) {
        for (let n = Math.min(start.length - 1, this.pending.length); n > 0; n--) {
          if (start.startsWith(this.pending.slice(-n))) { hold = n; break; }
        }
        const lastEscape = this.pending.lastIndexOf('\x1b');
        if (lastEscape >= 0) {
          const tail = this.pending.slice(lastEscape);
          if (tail === '\x1bO' || /^\x1b\[[\x20-\x3f]*$/.test(tail)) hold = Math.max(hold, tail.length);
        }
      }
      out.push(...decodeKeys(hold ? this.pending.slice(0, -hold) : this.pending));
      this.pending = hold ? this.pending.slice(-hold) : '';
      break;
    }
    return out;
  }
  flush() {
    this.pending += this.utf8.end();
    this.utf8 = new StringDecoder('utf8');
    return this.drain(true);
  }
}

function previousCharacter(line, cursor) {
  if (cursor <= 0) return 0;
  const last = line.charCodeAt(cursor - 1);
  const before = line.charCodeAt(cursor - 2);
  return cursor - (last >= 0xdc00 && last <= 0xdfff && before >= 0xd800 && before <= 0xdbff ? 2 : 1);
}

function nextCharacter(line, cursor) {
  if (cursor >= line.length) return line.length;
  return cursor + (line.codePointAt(cursor) > 0xffff ? 2 : 1);
}

export class LineEditor {
  constructor({ commands = SLASH_COMMANDS, history = [] } = {}) {
    this.commands = commands;
    this.history = history;
    this.line = '';
    this.cursor = 0;
    this.histIndex = null;
    this.draft = '';
  }
  get value() { return this.line; }
  setValue(v) { this.line = String(v ?? ''); this.cursor = this.line.length; this.histIndex = null; }
  insert(s) { this.line = this.line.slice(0, this.cursor) + s + this.line.slice(this.cursor); this.cursor += s.length; }
  backspace() { if (this.cursor > 0) { const prev = previousCharacter(this.line, this.cursor); this.line = this.line.slice(0, prev) + this.line.slice(this.cursor); this.cursor = prev; } }
  wordLeft() { while (this.cursor > 0 && this.line[this.cursor - 1] === ' ') this.cursor--; while (this.cursor > 0 && this.line[this.cursor - 1] !== ' ') this.cursor--; }
  wordRight() { while (this.cursor < this.line.length && this.line[this.cursor] !== ' ') this.cursor++; while (this.cursor < this.line.length && this.line[this.cursor] === ' ') this.cursor++; }
  historyUp() {
    if (!this.history.length) return;
    const next = this.histIndex === null ? this.history.length - 1 : Math.max(0, this.histIndex - 1);
    if (this.histIndex === null) this.draft = this.line;
    this.line = this.history[next];
    this.cursor = this.line.length;
    this.histIndex = next;
  }
  historyDown() {
    if (this.histIndex === null) return;
    if (this.histIndex >= this.history.length - 1) {
      this.line = this.draft;
      this.cursor = this.line.length;
      this.histIndex = null;
      return;
    }
    const next = this.histIndex + 1;
    this.line = this.history[next];
    this.cursor = this.line.length;
    this.histIndex = next;
  }
  complete() {
    if (!this.line.startsWith('/')) return false;
    const matches = this.commands.filter((x) => x.startsWith(this.line));
    if (matches.length === 1) { this.setValue(matches[0] + ' '); return true; }
    if (matches.length > 1) {
      let pref = matches[0];
      for (const m of matches.slice(1)) while (!m.startsWith(pref)) pref = pref.slice(0, -1);
      if (pref.length > this.line.length) { this.setValue(pref); return true; }
    }
    return false;
  }
  submit() {
    const v = this.line.trim();
    if (v) this.history.push(v);
    this.setValue('');
    return v;
  }
  handle(key) {
    const k = typeof key === 'string' || Buffer.isBuffer(key) ? decodeKey(key) : key;
    if (k.name === 'text' || k.name === 'paste') this.insert(k.value);
    else if (k.name === 'backspace') this.backspace();
    else if (k.name === 'left') this.cursor = previousCharacter(this.line, this.cursor);
    else if (k.name === 'right') this.cursor = nextCharacter(this.line, this.cursor);
    else if (k.name === 'home') this.cursor = 0;
    else if (k.name === 'end') this.cursor = this.line.length;
    else if (k.name === 'word-left') this.wordLeft();
    else if (k.name === 'word-right') this.wordRight();
    else if (k.name === 'up') this.historyUp();
    else if (k.name === 'down') this.historyDown();
    else if (k.name === 'tab') this.complete();
    return { line: this.line, cursor: this.cursor, hint: t('Listo', 'Ready') };
  }
}
