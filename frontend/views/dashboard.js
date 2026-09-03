import { normalizeTx } from '../config.js';
import { UI } from '../ui.js';
import { Store } from '../api.js';

// -------------------------------------------------------------- Dashboard --
// FR-050: the dashboard has no data of its own — it composes counts and a recent
// slice of transactions that already exist in Product/Inventory Transaction.
export function dashboard(container, query){
  let override = 'normal';

  function load(){
    container.innerHTML = skeletonHtml();
    // Phase 1 computed these six numbers from the local PRODUCTS/TRANSACTIONS
    // arrays; Phase 2 gets them pre-composed from one endpoint (GET
    // /dashboard/summary — see DashboardService), matching FR-050's own framing that
    // the dashboard owns no data of its own, it only reads what other modules hold.
    UI.mockFetch(async () => {
      if (override === 'empty'){
        return { activeProductsCount: 0, inactiveProductsCount: 0, lowStockCount: 0, outOfStockCount: 0, transactionsLast7Days: 0, recentActivity: [], needsAttention: [] };
      }
      const summary = await Store.getDashboardSummary();
      return { ...summary, recentActivity: summary.recentActivity.map(normalizeTx) };
    }, { forceState: override === 'error' ? 'error' : null })
      .then(data => { container.innerHTML = contentHtml(data); attach(); })
      .catch(err => { container.innerHTML = headerHtml() + UI.errorState(err.message, 'retry'); attach(); });
  }

  function skeletonHtml(){
    return headerHtml() + `
      <div class="stat-grid">${Array.from({length:4}).map(() => `<div class="stat-tile"><div class="skeleton skeleton-line" style="width:50%"></div><div class="skeleton skeleton-line" style="width:35%;height:26px;margin-top:8px"></div></div>`).join('')}</div>
      <div class="card"><div class="card-header"><h2>Recent Activity</h2></div>
        <div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(4,5)}</tbody></table></div></div>`;
  }

  function headerHtml(){
    return `<div class="content-header">
        <div><h1>Dashboard</h1><div class="sub">A quick health check on inventory — stock levels, alerts, and recent activity.</div></div>
        ${UI.previewControl(override)}
      </div>`;
  }

  function contentHtml(summary){
    const { activeProductsCount, inactiveProductsCount, lowStockCount, outOfStockCount, transactionsLast7Days, recentActivity, needsAttention } = summary;
    return headerHtml() + `
      <div class="stat-grid">
        <a class="stat-tile" href="#/products?status=active">
          <div class="label">Active Products</div>
          <div class="value tnum">${activeProductsCount}</div>
          <div class="foot">${inactiveProductsCount} inactive</div>
        </a>
        <a class="stat-tile" href="#/products?status=low">
          <div class="label">Low Stock</div>
          <div class="value tnum ${lowStockCount ? 'warning' : ''}">${lowStockCount}</div>
          <div class="foot">at or below threshold</div>
        </a>
        <a class="stat-tile" href="#/products?status=out">
          <div class="label">Out of Stock</div>
          <div class="value tnum ${outOfStockCount ? 'critical' : ''}">${outOfStockCount}</div>
          <div class="foot">0 units on hand</div>
        </a>
        <a class="stat-tile" href="#/history">
          <div class="label">Transactions, Last 7 Days</div>
          <div class="value tnum">${transactionsLast7Days}</div>
          <div class="foot">stock-in, stock-out &amp; adjustments</div>
        </a>
      </div>
      <div class="form-grid" style="align-items:start">
        <div class="card">
          <div class="card-header"><h2>Recent Activity</h2><a href="#/history" class="btn btn-ghost btn-sm">View all</a></div>
          ${recentActivity.length === 0 ? UI.emptyState('No recent activity', 'Transactions recorded across your inventory will show up here.') : `
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Product</th><th>Type</th><th>Qty</th><th>When</th><th>By</th></tr></thead>
            <tbody>${recentActivity.map(rowHtml).join('')}</tbody>
          </table></div>`}
        </div>
        <div class="card">
          <div class="card-header"><h2>Needs Attention</h2><a href="#/products?status=low" class="btn btn-ghost btn-sm">View all</a></div>
          ${needsAttention.length === 0 ? UI.emptyState('All caught up', 'No products are currently low on stock.') : `
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Product</th><th>Stock</th><th></th></tr></thead>
            <tbody>${needsAttention.map(p => `
              <tr class="clickable" data-goto="#/products/${p.id}">
                <td><div class="cell-name">${UI.esc(p.name)}</div><div class="cell-sub mono">${UI.esc(p.sku)}</div></td>
                <td class="tnum">${p.currentStock} ${UI.esc(p.unit)}</td>
                <td>${UI.badgeStockLevel(p)}</td>
              </tr>`).join('')}
          </table></div>`}
        </div>
      </div>`;
  }

  // t.product/t.recordedBy come pre-joined from the API (see InventoryService.listAll's
  // leftJoinAndSelect) — no separate Store.getProduct/getUser lookups needed anymore.
  function rowHtml(t){
    return `<tr class="clickable" data-goto="#/products/${t.productId}">
      <td><div class="cell-name">${UI.esc(t.product ? t.product.name : 'Unknown product')}</div></td>
      <td>${UI.typeBadge(t.type)}</td>
      <td class="tnum ${t.delta > 0 ? 'qty-pos' : 'qty-neg'}">${UI.fmtQty(t.delta, t.product ? t.product.unit : '')}</td>
      <td class="cell-sub">${UI.fmtDateTime(t.date)}</td>
      <td class="cell-sub">${t.recordedBy ? UI.esc(t.recordedBy.name) : '—'}</td>
    </tr>`;
  }

  function attach(){
    const sel = container.querySelector('#preview-select');
    if (sel) sel.addEventListener('change', e => { override = e.target.value; load(); });
    container.querySelectorAll('[data-goto]').forEach(row => row.addEventListener('click', () => UI.navigate(row.dataset.goto)));
    const retry = container.querySelector('#retry');
    if (retry) retry.addEventListener('click', () => { override = 'normal'; load(); });
  }

  load();
}
