// Phase 14 (docs/phase-14-plan.md §5 Fork G). The frontend's first automated test.
// Pure — no DOM — because `pagerModel` is the off-by-one-prone arithmetic the harness
// exists to pin: total pages via `Math.ceil`, the first/last-page boundaries, and the
// empty / exactly-divisible edge cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagerModel } from '../pager.js';
import { UI } from '../ui.js';

test('first page of many: no Prev, has Next, skip 0', () => {
  const m = pagerModel(1, 50, 573);
  assert.equal(m.totalPages, 12); // ceil(573 / 50)
  assert.equal(m.hasPrev, false);
  assert.equal(m.hasNext, true);
  assert.equal(m.skip, 0);
  assert.equal(m.showPager, true);
  assert.equal(m.label, 'Page 1 of 12');
});

test('last page: has Prev, no Next, skip past the earlier pages', () => {
  const m = pagerModel(12, 50, 573);
  assert.equal(m.hasNext, false);
  assert.equal(m.hasPrev, true);
  assert.equal(m.skip, 550);
});

test('a middle page has both Prev and Next', () => {
  const m = pagerModel(3, 50, 573);
  assert.equal(m.hasPrev, true);
  assert.equal(m.hasNext, true);
  assert.equal(m.skip, 100);
});

test('single page: one page, no controls, pager hidden', () => {
  const m = pagerModel(1, 50, 40);
  assert.equal(m.totalPages, 1);
  assert.equal(m.hasPrev, false);
  assert.equal(m.hasNext, false);
  assert.equal(m.showPager, false);
  assert.equal(UI.pager({ page: 1, pageSize: 50, total: 40, noun: 'products' }), '');
});

test('total exactly divisible by pageSize does not add a phantom empty page', () => {
  const m = pagerModel(2, 50, 100);
  assert.equal(m.totalPages, 2);
  assert.equal(m.hasNext, false);
  assert.equal(m.skip, 50);
});

test('total 0: one page, hidden, no negative skip', () => {
  const m = pagerModel(1, 50, 0);
  assert.equal(m.totalPages, 1);
  assert.equal(m.showPager, false);
  assert.equal(m.skip, 0);
});

test('a page past the last clamps into range rather than erroring', () => {
  const m = pagerModel(99, 50, 573);
  assert.equal(m.page, 12);
  assert.equal(m.hasNext, false);
  assert.equal(m.skip, 550);
});

test('a page below 1 clamps up to 1', () => {
  const m = pagerModel(0, 50, 573);
  assert.equal(m.page, 1);
  assert.equal(m.hasPrev, false);
});

test('UI.pager renders Prev/Next as data-pager buttons with the right disabled state', () => {
  const html = UI.pager({ page: 1, pageSize: 50, total: 573, noun: 'products' });
  assert.match(html, /data-pager="prev"[^>]*disabled/); // first page → Prev disabled
  assert.match(html, /data-pager="next"(?![^>]*disabled)/); // Next enabled
  assert.match(html, /Page 1 of 12 · 573 products/);

  const last = UI.pager({ page: 12, pageSize: 50, total: 573, noun: 'products' });
  assert.match(last, /data-pager="next"[^>]*disabled/);
  assert.match(last, /data-pager="prev"(?![^>]*disabled)/);
});
