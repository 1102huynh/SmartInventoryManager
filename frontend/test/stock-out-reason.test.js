// Phase 18 (docs/phase-18-plan.md), resolving product.md Q-4. The wiring test for the
// stock-out reason category (FR-025): that the wizard renders the #f-reason-cat picker
// with the fixed set, that choosing "Other" makes the free-text note mandatory
// (BR-023), and that a valid submit sends `reasonCategory` in the payload. jsdom, the
// same harness as history-filter.test.js.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let transactionWizard;
let Store;
let UI;

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

  ({ transactionWizard } = await import('../views/transactions.js'));
  ({ Store } = await import('../api.js'));
  ({ UI } = await import('../ui.js'));
});

const tick = () => new Promise((r) => setTimeout(r, 0));

let stockOutCalls;

beforeEach(() => {
  stockOutCalls = [];
  Store.getProduct = async () => ({
    id: 1,
    name: 'Espresso Beans, 1kg',
    unit: 'bag',
    currentStock: 100,
    status: 'active',
  });
  Store.recordStockOut = async (id, payload) => {
    stockOutCalls.push({ id, payload });
    return { id: 99, type: 'stock-out', delta: -3, reason: payload.reason || '', reasonCategory: payload.reasonCategory || null };
  };
  UI.toast = () => {};
});

function submitForm(container) {
  container.querySelector('#wizard-form').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
}

test('renders the reason-category picker with the fixed set of options', async () => {
  const container = document.createElement('div');
  transactionWizard(container, 1, 'stock-out');
  await tick();

  const select = container.querySelector('#f-reason-cat');
  assert.ok(select, '#f-reason-cat is present on a stock-out form');
  // one placeholder + the seven categories
  assert.equal(select.querySelectorAll('option').length, UI.STOCK_OUT_REASONS.length + 1);
  assert.deepEqual(
    [...select.querySelectorAll('option')].slice(1).map((o) => o.value),
    UI.STOCK_OUT_REASONS.map((r) => r[0]),
  );
  assert.ok(container.querySelector('#f-reason'), 'the free-text note field is present');
});

test('choosing "Other" makes the note required and blocks an empty submit', async () => {
  const container = document.createElement('div');
  transactionWizard(container, 1, 'stock-out');
  await tick();

  container.querySelector('#f-quantity').value = '3';
  const select = container.querySelector('#f-reason-cat');
  select.value = 'other';
  select.dispatchEvent(new window.Event('change'));
  await tick();

  // the note label now carries a required marker
  const noteField = container.querySelector('#f-reason').closest('.field');
  assert.ok(noteField.querySelector('.req'), '"Other" shows the note as required');

  submitForm(container);
  await tick();

  assert.ok(container.querySelector('.error'), 'an inline error is shown');
  assert.equal(container.querySelector('#btn-confirm'), null, 'did not advance to review');
  assert.equal(stockOutCalls.length, 0);
});

test('"Other" with a note advances to review and submits reasonCategory + note', async () => {
  const container = document.createElement('div');
  transactionWizard(container, 1, 'stock-out');
  await tick();

  container.querySelector('#f-quantity').value = '3';
  const select = container.querySelector('#f-reason-cat');
  select.value = 'other';
  select.dispatchEvent(new window.Event('change'));
  await tick();
  container.querySelector('#f-reason').value = 'Cleared a discontinued line';

  submitForm(container);
  await tick();

  const review = container.textContent;
  assert.match(review, /Other — Cleared a discontinued line/);

  container.querySelector('#btn-confirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();

  assert.equal(stockOutCalls.length, 1);
  assert.equal(stockOutCalls[0].payload.reasonCategory, 'other');
  assert.equal(stockOutCalls[0].payload.reason, 'Cleared a discontinued line');
});

test('a category with no note (Sale) is accepted and shown on review', async () => {
  const container = document.createElement('div');
  transactionWizard(container, 1, 'stock-out');
  await tick();

  container.querySelector('#f-quantity').value = '5';
  const select = container.querySelector('#f-reason-cat');
  select.value = 'sale';
  select.dispatchEvent(new window.Event('change'));
  await tick();

  submitForm(container);
  await tick();

  assert.match(container.textContent, /Sale/);
  container.querySelector('#btn-confirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();

  assert.equal(stockOutCalls.length, 1);
  assert.equal(stockOutCalls[0].payload.reasonCategory, 'sale');
});

test('no category picked still records a stock-out (FR-021 unchanged)', async () => {
  const container = document.createElement('div');
  transactionWizard(container, 1, 'stock-out');
  await tick();

  container.querySelector('#f-quantity').value = '2';
  submitForm(container);
  await tick();

  container.querySelector('#btn-confirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  await tick();

  assert.equal(stockOutCalls.length, 1);
  assert.equal(stockOutCalls[0].payload.reasonCategory, '');
});
