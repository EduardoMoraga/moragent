export class MoragentError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'MoragentError';
    this.code = code;
    this.hint = hint;
  }
}
