import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from '../src/core/log.js';
import { cellWidth } from '../src/tui/cell-width.js';
import { renderLive, visualRows } from '../src/tui/inline/render.js';
import { render } from '../src/tui/render.js';

test('inline and fullscreen drafts stay within terminal columns for CJK and emoji', () => {
  const input = '漢'.repeat(18) + '👩‍💻';
  const inline = renderLive({}, { input, cursor: input.length }, { cols: 20 });
  assert.ok(inline.every((line) => cellWidth(plain(line)) <= 20));
  assert.ok(inline.some((line) => line.includes('漢')));
  assert.ok(visualRows(inline, 20) >= inline.length);
  const screen = render({}, { cols: 40, rows: 20, input });
  assert.equal(screen.length, 20);
  assert.ok(screen.every((line) => cellWidth(plain(line)) <= 40));
  assert.ok(screen.some((line) => line.includes('漢')));
});
