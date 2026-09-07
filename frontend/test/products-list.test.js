// Phase 14 (docs/phase-14-plan.md §5 Fork G). The one DOM test: the paging *behaviour*
// that pure `pagerModel` can't cover — that the Product List holds `page` state across
// Prev/Next, and that a search/filter change snaps it back to page 1 and re-requests
// (a filtered result has its own page 1). jsdom, because this needs real event
// dispatch through the view's own `attach()` wiring.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let productList;
let Store;
let getCategories, setCategories;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  // config.js reads `window.API_BASE` at import time, so the globals have to exist
  // before the app modules are pulled in. Some of these (navigator) are getter-only
  // on modern Node, so define rather than assign.
  const put = (name, value) =>
    Object.defineProperty(global, name, { value, configurable: true, writable: true });
  put('window', dom.window);
  put('document', dom.window.document);
  put('navigator', dom.window.navigator);
  put('Event', dom.window.Event);
  put('MouseEvent', dom.window.MouseEvent);
  put('HTMLElement', dom.window.HTMLElement);

  ({ productList } = await import('../views/products.js'));
  ({ Store } = await import('../api.js'));
  ({ getCategories, setCategories } = await import('../reference-data.js'));
});

const PAGE_SIZE = 50;
let calls;

beforeEach(() => {
  calls = [];
  setCategories([]);
  // Stub the one network call the view makes. Echo back the requested page and a
  // total large enough that the pager renders with Next enabled.
  Store.listProducts = async (opts = {}) => {
    calls.push(opts);
    const page = opts.page ?? 1;
    return {
      items: [
        {
          id: page,
          name: `Product on page ${page}`,
          sku: `SKU-${page}`,
          unit: 'each',
          status: 'active',
          categoryId: null,
          currentStock: 0,
          lowStock: false,
          outOfStock: true,
          hasHistory: false,
        },
      ],
      total: 200,
      page,
    };
  };
});

// Lets the mockFetch promise chain (Promise.resolve().then(...)) settle.
const tick = () => new Promise((r) => setTimeout(r, 0));

test('first load requests page 1', async () => {
  const container = document.createElement('div');
  productList(container, new URLSearchParams());
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].page, 1);
  assert.equal(calls[0].pageSize, PAGE_SIZE);
  // The pager rendered (total 200 > pageSize 50) with Prev disabled on page 1.
  const prev = container.querySelector('[data-pager="prev"]');
  const next = container.querySelector('[data-pager="next"]');
  assert.ok(prev && prev.disabled);
  assert.ok(next && !next.disabled);
});

test('Next advances the page; Prev goes back', async () => {
  const container = document.createElement('div');
  productList(container, new URLSearchParams());
  await tick();

  container
    .querySelector('[data-pager="next"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(calls.at(-1).page, 2);

  container
    .querySelector('[data-pager="next"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(calls.at(-1).page, 3);

  container
    .querySelector('[data-pager="prev"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(calls.at(-1).page, 2);
});

test('a search change resets to page 1, even from page 3', async () => {
  const container = document.createElement('div');
  productList(container, new URLSearchParams());
  await tick();

  // Walk to page 3.
  for (let i = 0; i < 2; i++) {
    container
      .querySelector('[data-pager="next"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
  }
  assert.equal(calls.at(-1).page, 3);

  // Type in the search box.
  const searchInput = container.querySelector('#pl-search');
  searchInput.value = 'widget';
  searchInput.dispatchEvent(new window.Event('input'));
  await tick();

  const last = calls.at(-1);
  assert.equal(last.page, 1, 'search change must reset to page 1');
  assert.equal(last.search, 'widget');
});

test('a status filter change also resets to page 1', async () => {
  const container = document.createElement('div');
  productList(container, new URLSearchParams());
  await tick();

  container
    .querySelector('[data-pager="next"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(calls.at(-1).page, 2);

  const statusSelect = container.querySelector('#pl-status');
  statusSelect.value = 'low';
  statusSelect.dispatchEvent(new window.Event('change'));
  await tick();

  const last = calls.at(-1);
  assert.equal(last.page, 1);
  assert.equal(last.status, 'low');
});
