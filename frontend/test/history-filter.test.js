// Phase 17 (docs/phase-17-plan.md §3). The wiring test for the Inventory History
// product filter: that historyView mounts the typeahead into #h-product, that focus
// queries /products a page at a time (not the whole catalogue), and that picking a
// product re-requests the transaction list filtered by its id. jsdom, same harness as
// products-list.test.js.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let historyView;
let Store;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="toast-container"></div></body></html>', {
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

  ({ historyView } = await import('../views/transactions.js'));
  ({ Store } = await import('../api.js'));
});

const tick = () => new Promise((r) => setTimeout(r, 0));
// The production typeahead debounces at 200ms; wait it out before asserting on a query.
const settle = () => new Promise((r) => setTimeout(r, 240));
let txCalls;
let productCalls;

beforeEach(() => {
  txCalls = [];
  productCalls = [];
  Store.listAllTransactions = async (opts = {}) => {
    txCalls.push(opts);
    return { items: [], truncated: false };
  };
  Store.listProducts = async (opts = {}) => {
    productCalls.push(opts);
    return {
      items: [
        { id: 42, name: 'Espresso Beans, 1kg' },
        { id: 43, name: 'Whole Milk, 1L' },
      ],
      total: 2,
      page: 1,
    };
  };
});

test('mounts a typeahead into #h-product and loads the unfiltered log once', async () => {
  const container = document.createElement('div');
  historyView(container, new URLSearchParams());
  await tick();

  const mount = container.querySelector('#h-product');
  assert.ok(mount && mount.classList.contains('typeahead'), '#h-product is a typeahead');
  assert.ok(mount.querySelector('.typeahead-input'));
  assert.equal(txCalls.length, 1);
  assert.equal(txCalls[0].productId, undefined);
});

test('focus queries a bounded page of products, not the whole catalogue', async () => {
  const container = document.createElement('div');
  historyView(container, new URLSearchParams());
  await tick();

  container.querySelector('#h-product .typeahead-input').dispatchEvent(new window.Event('focus'));
  await settle();

  assert.equal(productCalls.length, 1);
  assert.equal(productCalls[0].pageSize, 20);
});

test('picking a product re-requests the log filtered by its id', async () => {
  const container = document.createElement('div');
  historyView(container, new URLSearchParams());
  await tick();

  const input = container.querySelector('#h-product .typeahead-input');
  input.dispatchEvent(new window.Event('focus'));
  await settle();
  container
    .querySelector('#h-product .typeahead-option')
    .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await tick();

  assert.equal(txCalls.at(-1).productId, 42);
  // and the picked label survives the re-render that load() triggers
  const input2 = container.querySelector('#h-product .typeahead-input');
  assert.equal(input2.value, 'Espresso Beans, 1kg');
});
