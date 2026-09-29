// Provider replies, tool logs, model names and project metadata are untrusted
// terminal input. Remove control sequences before applying MORAGENT's own styles.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|.)/g;

export function terminalText(value, { singleLine = false } = {}) {
  const clean = String(value ?? '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  return singleLine ? clean.replace(/\n/g, ' ') : clean;
}
