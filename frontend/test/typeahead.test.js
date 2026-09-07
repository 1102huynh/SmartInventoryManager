// Phase 17 (docs/phase-17-plan.md §3). The behaviour frontend/typeahead.js adds that
// no pure function can cover: a debounced query, a stale-response guard, selecting and
// clearing, and the "+N more" line that keeps the control honest when there are more
// matches than it shows. jsdom, because this is event dispatch through the factory's
// own wiring — the same harness as products-list.test.js.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let createTypeahead;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  const put = (name, value) =>
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  put('window', dom.window);
  put('document', dom.window.document);
  put('navigator', dom.window.navigator);
  put('Event', dom.window.Event);
  put('MouseEvent', dom.window.MouseEvent);
  put('KeyboardEvent', dom.window.KeyboardEvent);
  put('HTMLElement', dom.window.HTMLElement);

  ({ createTypeahead } = await import('../typeahead.js'));
});

const tick = () => new Promise((r) => setTimeout(r, 0));

// A search stub that records its calls and echoes a fixed result set.
function stubSearch(result) {
  const calls = [];
  const fn = async (q) => {
    calls.push(q);
    return typeof result === 'function' ? result(q) : result;
  };
  fn.calls = calls;
  return fn;
}

function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

test('focus with no selection queries the first page and opens the menu', async () => {
  const el = mount();
  const search = stubSearch({
    items: [
      { id: 1, label: 'Alpha' },
      { id: 2, label: 'Beta' },
    ],
    total: 2,
  });
  createTypeahead(el, { emptyLabel: 'All products', search, onSelect: () => {}, debounceMs: 0 });

  el.querySelector('.typeahead-input').dispatchEvent(new window.Event('focus'));
  await tick();

  assert.deepEqual(search.calls, ['']);
  const opts = el.querySelectorAll('.typeahead-option');
  assert.equal(opts.length, 2);
  assert.equal(opts[0].textContent, 'Alpha');
  assert.equal(el.querySelector('.typeahead-menu').hidden, false);
});

test('typing debounces to a single search with the trimmed query', async () => {
  const el = mount();
  const search = stubSearch({ items: [], total: 0 });
  createTypeahead(el, { search, onSelect: () => {}, debounceMs: 10 });

  const input = el.querySelector('.typeahead-input');
  for (const v of ['w', 'wi', 'wid ']) {
    input.value = v;
    input.dispatchEvent(new window.Event('input'));
  }
  await new Promise((r) => setTimeout(r, 25));

  assert.deepEqual(search.calls, ['wid']);
  assert.ok(el.querySelector('.typeahead-empty'), 'renders the no-matches line');
});

test('selecting an option commits it and shows its label', async () => {
  const el = mount();
  let picked;
  const search = stubSearch({ items: [{ id: 7, label: 'Gamma' }], total: 1 });
  createTypeahead(el, {
    emptyLabel: 'All products',
    search,
    onSelect: (s) => { picked = s; },
    debounceMs: 0,
  });

  el.querySelector('.typeahead-input').dispatchEvent(new window.Event('focus'));
  await tick();
  el.querySelector('.typeahead-option').dispatchEvent(
    new window.MouseEvent('mousedown', { bubbles: true }),
  );

  assert.deepEqual(picked, { id: 7, label: 'Gamma' });
  assert.equal(el.querySelector('.typeahead-input').value, 'Gamma');
  assert.equal(el.querySelector('.typeahead-menu').hidden, true);
  assert.equal(el.querySelector('.typeahead-clear').hidden, false);
});

test('more matches than shown renders the "+N more" hint', async () => {
  const el = mount();
  const search = stubSearch({
    items: Array.from({ length: 20 }, (_, i) => ({ id: i, label: `Item ${i}` })),
    total: 63,
  });
  createTypeahead(el, { search, onSelect: () => {}, debounceMs: 0 });

  el.querySelector('.typeahead-input').dispatchEvent(new window.Event('focus'));
  await tick();

  const more = el.querySelector('.typeahead-more');
  assert.ok(more);
  assert.match(more.textContent, /\+43 more/);
});

test('clear resets to the empty state and reports null', async () => {
  const el = mount();
  const events = [];
  const search = stubSearch({ items: [{ id: 1, label: 'Alpha' }], total: 1 });
  createTypeahead(el, {
    emptyLabel: 'All products',
    initial: { id: 1, label: 'Alpha' },
    search,
    onSelect: (s) => events.push(s),
    debounceMs: 0,
  });

  const input = el.querySelector('.typeahead-input');
  assert.equal(input.value, 'Alpha', 'initial selection seeds the input');

  el.querySelector('.typeahead-clear').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(events, [null]);
  assert.equal(input.value, '');
  assert.equal(el.querySelector('.typeahead-clear').hidden, true);
});

test('Enter with the menu open picks the first option and does not submit a form', async () => {
  const el = mount();
  const form = document.createElement('form');
  let submitted = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitted = true;
  });
  form.appendChild(el);
  document.body.appendChild(form);

  let picked;
  const search = stubSearch({
    items: [
      { id: 1, label: 'First' },
      { id: 2, label: 'Second' },
    ],
    total: 2,
  });
  createTypeahead(el, { search, onSelect: (s) => { picked = s; }, debounceMs: 0 });

  const input = el.querySelector('.typeahead-input');
  input.dispatchEvent(new window.Event('focus'));
  await tick();
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  assert.deepEqual(picked, { id: 1, label: 'First' });
  assert.equal(submitted, false);
});

test('a stale (slow) response does not overwrite a newer one', async () => {
  const el = mount();
  const deferred = [];
  const search = (q) =>
    new Promise((resolve) => {
      deferred.push({ q, resolve });
    });
  createTypeahead(el, { search, onSelect: () => {}, debounceMs: 0 });

  const input = el.querySelector('.typeahead-input');
  input.value = 'a';
  input.dispatchEvent(new window.Event('input'));
  await tick();
  input.value = 'ab';
  input.dispatchEvent(new window.Event('input'));
  await tick();

  assert.equal(deferred.length, 2);
  // Resolve the NEWER request first, then the older, out of order.
  deferred[1].resolve({ items: [{ id: 2, label: 'AB match' }], total: 1 });
  await tick();
  deferred[0].resolve({ items: [{ id: 1, label: 'A match' }], total: 1 });
  await tick();

  const opts = [...el.querySelectorAll('.typeahead-option')].map((o) => o.textContent);
  assert.deepEqual(opts, ['AB match'], 'the later query wins');
});
