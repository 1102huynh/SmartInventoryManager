import { UI } from '../ui.js';
import { Store } from '../api.js';

// -------------------------------------------------------------- Categories --
// FR-005/phase-4-plan.md §3. A small admin screen for the categories used to
// organize products, reached via "Manage categories" from the product list's
// category filter rather than a separate nav section — the app already surfaces
// admin actions contextually instead of inventing a new nav pattern for something
// this small. List-with-inline-actions (rename in place, delete with an
// explicit consequence-aware confirmation), not a separate detail/edit page —
// a Category is just a name, so a whole extra screen per action would be more
// navigation than the entity is worth.
export function categoryList(container, query){
  let products = []; // used only to compute each category's product count client-side
  let categories = []; // Phase 14: the current page's rows (server-ordered by name)
  let editingId = null;
  let editValue = '';
  let editError = '';
  let confirmDeleteId = null;
  let newName = '';
  let addError = '';
  // Phase 14 (docs/phase-14-plan.md §3): this screen now reads a *page* of categories
  // via Store.listCategoriesPaged — not the global CATEGORIES cache, which
  // loadReferenceData still fills unpaged for every product form's dropdown. The
  // product-count read (Store.listProducts, no paging param) stays a whole-catalogue
  // fetch; that read is one of the §1 "second consumer" callers the optional-paging
  // design protects.
  const PAGE_SIZE = 50;
  let page = 1;
  let total = 0;

  function load(){
    container.innerHTML = header() + `<div class="table-wrap"><table class="data-table"><tbody>${UI.skeletonRows(3,4)}</tbody></table></div>`;
    Promise.all([
      Store.listProducts(),
      Store.listCategoriesPaged({ page, pageSize: PAGE_SIZE }),
    ]).then(([productList, catPage]) => {
      products = productList;
      categories = catPage.items;
      total = catPage.total;
      page = catPage.page;
      render();
    }).catch(err => { container.innerHTML = header() + UI.errorState(err.message, 'retry'); container.querySelector('#retry')?.addEventListener('click', load); });
  }

  function pagerHtml(){
    return UI.pager({ page, pageSize: PAGE_SIZE, total, noun: 'categories' });
  }

  function header(){
    return `<div class="content-header">
      <div><h1>Categories</h1><div class="sub">The categories used to organize products.</div></div>
    </div>`;
  }

  function countFor(categoryId){
    return products.filter(p => p.categoryId === categoryId).length;
  }

  function addFormHtml(){
    return `<div class="card card-pad" style="max-width:420px;margin-bottom:16px">
      <form id="cat-add-form" novalidate>
        <div class="field${addError ? ' has-error' : ''}">
          <label>Add Category</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="f-new-name" placeholder="e.g. Beverages & Café Supplies" value="${UI.esc(newName)}">
            <button type="submit" class="btn btn-primary">${UI.icon('plus')} Add</button>
          </div>
          ${addError ? `<div class="error">${addError}</div>` : ''}
        </div>
      </form>
    </div>`;
  }

  function body(list){
    if (list.length === 0) return UI.emptyState('No categories yet', 'Add a category above to start organizing products.');
    return `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>Category</th><th>Products</th><th></th></tr></thead>
      <tbody>${list.map(rowHtml).join('')}</tbody>
    </table></div>`;
  }

  function rowHtml(c){
    const count = countFor(c.id);
    // Delete confirmation states the consequence explicitly (§3: "N products will
    // become uncategorized") rather than a generic "are you sure?", since delete is
    // irreversible and silently uncategorizes anything currently using it.
    if (confirmDeleteId === c.id){
      return `<tr>
        <td class="cell-name">${UI.esc(c.name)}</td>
        <td class="tnum">${count}</td>
        <td><div class="confirm-inline">${count > 0 ? `${count} product${count === 1 ? '' : 's'} will become uncategorized.` : 'Delete this category?'}
          <button class="btn btn-ghost btn-sm" data-cancel-delete="${c.id}">Cancel</button>
          <button class="btn btn-danger btn-sm" data-do-delete="${c.id}">Confirm</button>
        </div></td>
      </tr>`;
    }
    if (editingId === c.id){
      return `<tr>
        <td><div class="field${editError ? ' has-error' : ''}" style="margin:0">
          <input type="text" id="edit-name-${c.id}" value="${UI.esc(editValue)}">
          ${editError ? `<div class="error">${editError}</div>` : ''}
        </div></td>
        <td class="tnum">${count}</td>
        <td class="action-row">
          <button class="btn btn-ghost btn-sm" data-cancel-edit="${c.id}">Cancel</button>
          <button class="btn btn-primary btn-sm" data-save-edit="${c.id}">Save</button>
        </td>
      </tr>`;
    }
    return `<tr>
      <td class="cell-name">${UI.esc(c.name)}</td>
      <td class="tnum">${count} product${count === 1 ? '' : 's'}</td>
      <td class="action-row">
        <button class="btn btn-ghost btn-sm" data-start-edit="${c.id}">Rename</button>
        <button class="btn btn-ghost btn-sm" data-start-delete="${c.id}">Delete</button>
      </td>
    </tr>`;
  }

  function render(){
    // `categories` is already the server's name-ordered page — no client-side sort.
    container.innerHTML = header() + addFormHtml() + body(categories) + pagerHtml();
    attach();
  }

  function attach(){
    container.querySelector('#cat-add-form').addEventListener('submit', e => {
      e.preventDefault();
      newName = container.querySelector('#f-new-name').value;
      if (!newName.trim()){ addError = 'Category name is required.'; render(); return; }
      Store.createCategory({ name: newName }).then(() => {
        UI.toast('Category created.', 'success');
        newName = ''; addError = '';
        return load(); // Phase 14: re-fetch the page — the new row may belong on it
      }).catch(err => { addError = err.message; render(); });
    });

    container.querySelectorAll('[data-start-edit]').forEach(btn => btn.addEventListener('click', () => {
      const id = Number(btn.dataset.startEdit);
      editingId = id;
      editValue = categories.find(c => c.id === id)?.name || '';
      editError = '';
      render();
      container.querySelector(`#edit-name-${id}`)?.focus();
    }));
    container.querySelectorAll('[data-cancel-edit]').forEach(btn => btn.addEventListener('click', () => {
      editingId = null; editError = ''; render();
    }));
    container.querySelectorAll('[data-save-edit]').forEach(btn => btn.addEventListener('click', () => {
      const id = Number(btn.dataset.saveEdit);
      const input = container.querySelector(`#edit-name-${id}`);
      const value = input ? input.value : '';
      if (!value.trim()){ editError = 'Category name is required.'; editValue = value; render(); return; }
      Store.updateCategory(id, { name: value }).then(() => {
        UI.toast('Category renamed.', 'success');
        editingId = null; editError = '';
        return load(); // Phase 14: the rename can change name-order / page membership
      }).catch(err => { editError = err.message; editValue = value; render(); });
    }));

    container.querySelectorAll('[data-start-delete]').forEach(btn => btn.addEventListener('click', () => {
      confirmDeleteId = Number(btn.dataset.startDelete); render();
    }));
    container.querySelectorAll('[data-cancel-delete]').forEach(btn => btn.addEventListener('click', () => {
      confirmDeleteId = null; render();
    }));
    container.querySelectorAll('[data-do-delete]').forEach(btn => btn.addEventListener('click', () => {
      const id = Number(btn.dataset.doDelete);
      const name = categories.find(c => c.id === id)?.name || 'Category';
      Store.deleteCategory(id).then(() => {
        UI.toast(`${name} deleted.`, 'success');
        confirmDeleteId = null;
        // A delete can leave the current page past the end (e.g. the only row on the
        // last page) — step back one if this page is now empty.
        if (categories.length === 1 && page > 1) page -= 1;
        return load(); // re-fetch products too — a deleted category may have just orphaned some
      }).catch(err => { UI.toast(err.message, 'error'); confirmDeleteId = null; render(); });
    }));

    // Phase 14: pager Prev/Next (no inline handler — §3).
    container.querySelectorAll('[data-pager]').forEach(btn => btn.addEventListener('click', () => {
      if (btn.disabled) return;
      page += btn.dataset.pager === 'next' ? 1 : -1;
      load();
    }));

    const retry = container.querySelector('#retry');
    if (retry) retry.addEventListener('click', load);
  }

  load();
}
