import { t } from '../core/i18n.js';

export const SLASH_COMMANDS = ['/login', '/plan', '/equipo', '/orquestador', '/memoria', '/abrir', '/nuevo', '/cancel', '/help', '/salir'];

export function decodeKey(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s === '\r' || s === '\n') return { name: 'enter' };
  if (s === '\u0003') return { name: 'ctrl-c' };
  if (s === '\u001b') return { name: 'escape' };
  if (s === '\t') return { name: 'tab' };
  if (s === '\u007f' || s === '\b') return { name: 'backspace' };
  if (s === '\u001b[A') return { name: 'up' };
  if (s === '\u001b[B') return { name: 'down' };
  if (s === '\u001b[C') return { name: 'right' };
  if (s === '\u001b[D') return { name: 'left' };
  if (s === '\u001b[H' || s === '\u001bOH') return { name: 'home' };
  if (s === '\u001b[F' || s === '\u001bOF') return { name: 'end' };
  if (s === '\u001b[5~') return { name: 'pageup' };
  if (s === '\u001b[6~') return { name: 'pagedown' };
  if (s === '\u001bb' || s === '\u001b[1;5D') return { name: 'word-left' };
  if (s === '\u001bf' || s === '\u001b[1;5C') return { name: 'word-right' };
  if (s >= ' ' && s !== '\u007f') return { name: 'text', value: s };
  return { name: 'unknown', raw: s };
}

export function decodeKeys(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s.startsWith('\u001b')) return [decodeKey(s)];
  if (s.length <= 1) return [decodeKey(s)];
  return [...s].map((ch) => decodeKey(ch));
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
  backspace() { if (this.cursor > 0) { this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor); this.cursor--; } }
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
    if (k.name === 'text') this.insert(k.value);
    else if (k.name === 'backspace') this.backspace();
    else if (k.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (k.name === 'right') this.cursor = Math.min(this.line.length, this.cursor + 1);
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
