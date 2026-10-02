// Terminal columns, not JavaScript code units. Segment by grapheme so emoji
// sequences and combining marks remain intact when a line is clipped.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wide = /[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const emoji = /\p{Extended_Pictographic}/u;
const combining = /\p{Mark}/u;

export function graphemes(value) {
  return Array.from(segmenter.segment(String(value ?? '')), (item) => item.segment);
}

export function cellWidth(value) {
  let columns = 0;
  for (const glyph of graphemes(value)) {
    if (!glyph || /^[\x00-\x1f\x7f-\x9f]$/.test(glyph)) continue;
    if (wide.test(glyph) || emoji.test(glyph)) columns += 2;
    else if (Array.from(glyph).some((char) => !combining.test(char))) columns += 1;
  }
  return columns;
}

export function clipCells(value, columns) {
  if (columns <= 0) return '';
  if (cellWidth(value) <= columns) return value;
  let result = '';
  for (const glyph of graphemes(value)) {
    if (cellWidth(result + glyph) > columns - 1) break;
    result += glyph;
  }
  return result + '…';
}
