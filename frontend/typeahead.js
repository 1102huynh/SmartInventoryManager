// Phase 17 (docs/phase-17-plan.md §3). One shared search-as-you-type control, used by
// the stock-in wizard's supplier picker and the Inventory History product filter
// (frontend/views/transactions.js). Both used to render a <select> of the entire
// catalogue — the "unbounded read" correctness cliff Phase 14 §1 left open: a picker
// silently capped at 50 means option #51 cannot be chosen. This queries a paged,
// searchable route instead and, when there are more matches than it shows, says so
// rather than dropping them.
//
// Its own module (not a UI.* helper) because it holds real behaviour — a debounce, a
// stale-response guard, keyboard navigation, a menu that opens and closes — that two
// views share and frontend/test/typeahead.test.js covers directly, the pager.js
// precedent from Phase 14.
//
// The Phase 13 invariant holds: every listener here is attached by this factory to an
// element it just created; nothing relies on an inline on* handler.

import { UI } from './ui.js';

// The caller supplies `search` (query -> Promise<{ items: [{ id, label }], total }>)
// and `onSelect` ({ id, label } | null). `emptyLabel` is the placeholder / cleared
// state; `initial` seeds the committed selection (so the control survives a view
// re-render); `minChars` and `debounceMs` are knobs — tests pass `debounceMs: 0`.
export function createTypeahead(
  mountEl,
  {
    emptyLabel = 'Any',
    initial = null,
    search,
    onSelect,
    minChars = 0,
    debounceMs = 200,
  } = {},
) {
  let selected = initial; // { id, label } | null — the last committed pick
  let activeIndex = -1; // highlighted option while the menu is open, -1 = none
  let options = []; // [{ id, label }] currently rendered
  let more = 0; // matches beyond what `options` shows
  let seq = 0; // bumped per search; a response with a stale seq is dropped
  let debounceTimer = null;

  mountEl.classList.add('typeahead');
  mountEl.innerHTML = `
    <div class="typeahead-field">
      ${UI.icon('search')}
      <input type="text" class="typeahead-input" autocomplete="off" spellcheck="false"
             role="combobox" aria-expanded="false" aria-autocomplete="list">
      <button type="button" class="typeahead-clear" aria-label="Clear selection" hidden>&times;</button>
    </div>
    <div class="typeahead-menu" role="listbox" hidden></div>`;

  const input = mountEl.querySelector('.typeahead-input');
  const clearBtn = mountEl.querySelector('.typeahead-clear');
  const menu = mountEl.querySelector('.typeahead-menu');

  input.placeholder = emptyLabel;
  syncInputToSelection();

  // The visible text always reflects the committed selection — never a half-typed
  // query that isn't applied.
  function syncInputToSelection() {
    input.value = selected ? selected.label : '';
    clearBtn.hidden = !selected;
  }

  function openMenu() {
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function renderMenu() {
    const rows = options.map(
      (o, i) =>
        `<div class="typeahead-option${i === activeIndex ? ' is-active' : ''}"
              role="option" data-idx="${i}" aria-selected="${i === activeIndex}">${UI.esc(o.label)}</div>`,
    );
    if (options.length === 0) rows.push('<div class="typeahead-empty">No matches</div>');
    if (more > 0)
      rows.push(
        `<div class="typeahead-more">+${more} more — keep typing to narrow</div>`,
      );
    menu.innerHTML = rows.join('');
  }

  function runSearch(query) {
    const mySeq = ++seq;
    Promise.resolve(search(query))
      .then((res) => {
        if (mySeq !== seq) return; // a newer search has since been fired
        options = (res && res.items) || [];
        const total =
          res && typeof res.total === 'number' ? res.total : options.length;
        more = Math.max(0, total - options.length);
        activeIndex = -1;
        renderMenu();
        openMenu();
      })
      .catch(() => {
        if (mySeq !== seq) return;
        options = [];
        more = 0;
        renderMenu();
        openMenu();
      });
  }

  function scheduleSearch(query) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(query), debounceMs);
  }

  function commit(opt) {
    selected = opt ? { id: opt.id, label: opt.label } : null;
    syncInputToSelection();
    closeMenu();
    onSelect(selected ? { ...selected } : null);
  }

  // ---- listeners, all on elements this factory owns ----

  input.addEventListener('focus', () => {
    // An empty control still behaves like the <select> it replaces — focus shows the
    // first page so a short list is just there to pick from.
    if (!selected) scheduleSearch('');
  });

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < minChars) {
      closeMenu();
      return;
    }
    scheduleSearch(q);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.hidden) {
        scheduleSearch(input.value.trim());
        return;
      }
      const n = options.length;
      if (n === 0) return;
      activeIndex =
        e.key === 'ArrowDown'
          ? (activeIndex + 1) % n
          : (activeIndex - 1 + n) % n;
      renderMenu();
    } else if (e.key === 'Enter') {
      // With the menu open, Enter belongs to the picker, not to whatever form the
      // input sits in (the stock-in wizard submits on Enter). Highlighted option, or
      // the first one if the user just typed and hit Enter.
      if (!menu.hidden) {
        e.preventDefault();
        const pick = options[activeIndex >= 0 ? activeIndex : 0];
        if (pick) commit(pick);
      }
    } else if (e.key === 'Escape') {
      if (!menu.hidden) {
        e.preventDefault();
        closeMenu();
        syncInputToSelection();
      }
    }
  });

  // mousedown, not click — it fires before the input's blur, so the pick lands before
  // blur would revert the text.
  menu.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.typeahead-option');
    if (!row) return;
    e.preventDefault();
    const opt = options[Number(row.dataset.idx)];
    if (opt) commit(opt);
  });

  input.addEventListener('blur', () => {
    // Deferred past any pending option mousedown; if nothing was picked, the text
    // snaps back to the committed selection.
    setTimeout(() => {
      closeMenu();
      syncInputToSelection();
    }, 0);
  });

  clearBtn.addEventListener('click', () => {
    commit(null);
    input.focus();
  });

  const onDocMouseDown = (e) => {
    if (!mountEl.contains(e.target)) closeMenu();
  };
  document.addEventListener('mousedown', onDocMouseDown);

  return {
    // Views re-render on every load(); the outgoing instance drops its document
    // listener and invalidates any in-flight search so a late response can't render
    // into a detached menu.
    destroy() {
      if (debounceTimer) clearTimeout(debounceTimer);
      seq++;
      document.removeEventListener('mousedown', onDocMouseDown);
    },
  };
}
