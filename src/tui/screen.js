export class TerminalScreen {
  constructor({ input = process.stdin, output = process.stdout, fps = 30 } = {}) {
    this.input = input;
    this.output = output;
    this.delay = Math.max(1, Math.floor(1000 / fps));
    this.timer = null;
    this.dirty = false;
    this.renderFn = null;
    this.closed = false;
    this.wasRaw = false;
    this.onResize = null;
    this._restore = () => this.restore();
  }
  start(renderFn) {
    this.renderFn = renderFn;
    this.closed = false;
    this.output.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    if (this.input.isTTY && this.input.setRawMode) {
      this.wasRaw = this.input.isRaw;
      this.input.setRawMode(true);
      this.input.resume();
    }
    this.onResize = () => this.requestRender();
    this.output.on?.('resize', this.onResize);
    process.once('exit', this._restore);
    process.once('uncaughtException', (err) => { this.restore(); throw err; });
    process.once('unhandledRejection', (err) => { this.restore(); throw err; });
    this.requestRender(true);
  }
  size() {
    return { cols: this.output.columns || 80, rows: this.output.rows || 24 };
  }
  requestRender(now = false) {
    if (this.closed) return;
    this.dirty = true;
    if (now) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.renderFn || this.closed) return;
    this.dirty = false;
    const lines = this.renderFn(this.size());
    this.output.write('\x1b[H' + lines.join('\n'));
  }
  restore() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.output.off?.('resize', this.onResize);
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(Boolean(this.wasRaw));
    this.output.write('\x1b[?25h\x1b[?1049l');
    process.removeListener('exit', this._restore);
  }
}
