import { StringDecoder } from 'node:string_decoder';
import { decodeKey } from '../input.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function cleanPaste(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))?/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Raw terminal chunks are not key boundaries. In particular, bracketed-paste
// markers and UTF-8 characters may arrive in separate data events.
export class InlineInputDecoder {
  constructor() {
    this.utf8 = new StringDecoder('utf8');
    this.pending = '';
    this.pasting = false;
    this.paste = '';
  }

  get waitingForEscape() { return this.pending === '\x1b' && !this.pasting; }

  flushEscape() {
    if (!this.waitingForEscape) return [];
    this.pending = '';
    return [{ name: 'escape' }];
  }

  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? this.utf8.write(chunk) : String(chunk);
    const keys = [];
    this.pending += text;
    while (this.pending) {
      if (this.pasting) {
        const content = this.paste + this.pending;
        const end = content.indexOf(PASTE_END);
        if (end === -1) {
          this.paste = content;
          this.pending = '';
          break;
        }
        keys.push({ name: 'paste', value: cleanPaste(content.slice(0, end)) });
        this.paste = '';
        this.pending = content.slice(end + PASTE_END.length);
        this.pasting = false;
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      if (PASTE_START.startsWith(this.pending)) break;

      if (this.pending[0] === '\x1b') {
        if (this.pending.length === 1) break;
        if (this.pending[1] === '[') {
          const sequence = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending)?.[0];
          if (!sequence) break;
          keys.push(sequence === '\x1b[13;2u' || sequence === '\x1b[27;2;13~'
            ? { name: 'newline' } : decodeKey(sequence));
          this.pending = this.pending.slice(sequence.length);
          continue;
        }
        if (this.pending[1] === 'O') {
          if (this.pending.length < 3) break;
          keys.push(decodeKey(this.pending.slice(0, 3)));
          this.pending = this.pending.slice(3);
          continue;
        }
        const meta = this.pending[1] === '\x1b' ? '\x1b' : '\x1b' + String.fromCodePoint(this.pending.codePointAt(1));
        keys.push(/^\x1b[\r\n]$/.test(meta) ? { name: 'newline' } : /^\x1b[bf]$/.test(meta) ? decodeKey(meta) : { name: 'unknown', raw: meta });
        this.pending = this.pending.slice(meta.length);
        continue;
      }

      const codepoint = String.fromCodePoint(this.pending.codePointAt(0));
      keys.push(codepoint === '\n' ? { name: 'newline' } : decodeKey(codepoint));
      this.pending = this.pending.slice(codepoint.length);
    }
    return keys;
  }
}
