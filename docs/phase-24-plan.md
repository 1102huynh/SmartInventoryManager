# Phase 24 Plan — Indexes on the catalogue orderings: measured, not added

Status: Phase 24 — Complete (measurement + decision; no code, no migration, no schema change)
Last updated: 2026-09-08
Scope decided with the project owner: **`EXPLAIN` the Phase 14 paged catalogue query at
realistic row counts and decide, on that evidence, whether `products.name` /
`suppliers.name` / the `users` ordering need an index — then record the decision.** This
is issue #14, and it is the conditional follow-on Phase 11 §7 and Phase 14 §7 each named
by hand ("still unindexed, still not on the evidence bar … `EXPLAIN` the paged query; add
an index only if a realistic row count shows it needs one").

Scoped the same way every phase in this series has been: one headline question, an
explicit out-of-scope list, no punch-list riding along. **Unlike every phase since Phase
6, this one ships no code and no migration** — the deliverable is the measurement and
the decision it forces, which is exactly the shape the two deferrals asked for.

## Why this phase, why now

The four catalogue orderings have been unindexed since Phase 2, and three phases said so
in writing while declining to act:

| Phase | What it said about a `name` / ordering index |
|---|---|
| 11 §7 | "`tx.type`, `tx.supplier_id`, and the catalogue tables' `name` orderings are all unindexed too. None of them is on the path of a read this phase caps, and adding indexes because they might help is the speculation this project's own 'what evidence to look for' section argues against." |
| 14 §7 | "An index on `products.name` / `suppliers.name` / the `users` ordering — still unindexed, still not on the evidence bar (Phase 11 §7). `EXPLAIN` the paged query; add an index only if a realistic row count shows it needs one." |
| 23 §7 | "An index on `products.current_stock` — over a few-hundred-row `products` table a scan is fine (the same bar Phase 11 §7 and Phase 14 §7 set for `products.name`). `EXPLAIN` the filtered query; add an index only if a realistic row count shows it needs one." |

**The trigger, stated in this project's register.** It is not that the Product List got
slow — it has not, every environment still runs `npm run seed`'s 15 products. It is that
Phase 14 shipped the paged query the two deferrals point at, and Phase 23 finished
reshaping it (the `current_stock` column replaced the grouped `SUM`; `hasHistory` became
a correlated `EXISTS`). The query the `EXPLAIN` was deferred against now exists in its
final form. Running the measurement now costs an afternoon and closes a standing
question with a number; leaving it open means every future catalogue phase re-inherits
the same "should there be an index here?" paragraph. **If the owner reads this as not
worth a phase, the coherent choice is to fold the measurement into whichever phase next
touches these reads** — not to leave it as a perpetual §7 line. This plan is written on
the judgement that a standing conditional deferral is worth discharging with evidence
once the thing it is conditioned on is built.

**This phase changes no domain document** — no new FR, no new BR, no entity, no route, no
query parameter, no migration. The only files that change are `docs/phase-24-plan.md`
(this file), `architecture-observations.md`, and the standing "no new FR / no new BR"
notes in `requirements.md` / `business-rules.md`, plus the phase pointers in `README.md`,
`product.md` §11, and `api.md`'s title line.

---

## 1. The measurement and the decision

### `users` — ordered by `id ASC`. Already an index scan; nothing to add, nothing ever needed adding.

`GET /users` orders by `id ASC` (`users.service.ts` `findAll`). `id` is the primary key,
and Postgres backs every primary key with a unique B-tree index — `UsersService.findAll`'s
`ORDER BY users.id ASC LIMIT :take OFFSET :skip` has been an ordered index scan since
`InitSchema`:

```
public.users indexes:
  PK_a3ffb1c0c8416b9fc6f907b7433  UNIQUE btree (id)
  UQ_users_email                  UNIQUE btree (email)
```

There is no index to add. This is recorded here permanently so the `users` half of the
issue stops being re-raised: an `ORDER BY <primary key>` is never the unindexed-sort case
the other two orderings are, and `/users` is Owner-only and tiny in every realistic
deployment besides (`users.service.ts` says so already).

### `products.name` / `suppliers.name` — ordered by `name ASC`, unindexed. Measured across four scales.

**Method.** `TEMP` tables mirroring the real `products` / `suppliers` column shape,
populated from `generate_series` with names uncorrelated with `id` (`md5(g::text) || …`),
at **200 / 1,000 / 10,000 / 100,000** rows; a companion `itx` table (three rows per
product, indexed on `product_id`) for the `hasHistory` `EXISTS`. `EXPLAIN (ANALYZE,
BUFFERS)` of the exact Phase 14 paged shape, `max_parallel_workers_per_gather = 0` for
deterministic plans, run with and without `CREATE INDEX … ON p (name)`. The script is in
the appendix; it touches no real table and is re-runnable against the dev database.

The query measured (products; suppliers is the same without the `EXISTS` and the
`current_stock` filters, i.e. strictly cheaper):

```sql
SELECT p.*, EXISTS (SELECT 1 FROM inventory_transactions itx WHERE itx.product_id = p.id) AS "hasHistory"
FROM products p
ORDER BY p.name ASC
LIMIT 20 OFFSET :offset;         -- LIMIT is DTO-capped at MAX_PAGE_SIZE = 100
```

**Results** — `Execution Time`, median of repeated runs:

| rows | first page, **no index** | first page, `INDEX(name)` | `getCount()` (the `total`) | deep page `OFFSET n−20`, no index | deep page, `INDEX(name)` |
|---:|---:|---:|---:|---:|---:|
| 200 | **0.20 ms** | 0.24 ms | 0.04 ms | 0.20 ms | 0.24 ms |
| 1,000 | **0.79 ms** | 0.62 ms | 0.07 ms | 0.94 ms | 0.93 ms |
| 10,000 | 5.7 ms | 4.5 ms | 0.65 ms | 12 ms | 8.8 ms |
| 100,000 | 13 ms | 0.75 ms | 9.2 ms | 266 ms | **1795 ms** |

**Reading the numbers.**

- **At the scale this product is designed for, the ordered page is already
  sub-millisecond and the index is noise.** `product.md` §7 sizes the catalogue at
  "dozens of products"; 200 is generous and 1,000 is past the stated scale. At 200 rows
  the index makes the first page *slower* by measurement noise; at 1,000 it saves
  ~0.17 ms. Neither is a number a person or an HTTP timeout can perceive.
- **`MAX_PAGE_SIZE = 100` pins the sort.** The first page is a `top-N heapsort` with
  `Memory: 29kB` at every scale from 200 to 100,000 — the DTO ceiling means Postgres
  never sorts more than it returns. The sort is not the thing that grows.
- **What grows past 10k is the per-row `EXISTS` and the seq scan — which a `name` index
  does not remove.** At 100k the no-index first page is 13 ms, of which the `Seq Scan on
  products` and the `EXISTS` subplan are the bulk; the `name` index turns the scan into
  an index scan and gets to 0.75 ms, but that is the *only* path where it clearly wins,
  and it is the path that was already fast enough.
- **`getCount()` is unhelped at every scale.** The `total` in the paged envelope is a
  `COUNT(*)` over the *filtered* set — always a `Seq Scan` + `Aggregate`, no `ORDER BY`
  for an index to satisfy. 9 ms at 100k, and a `name` index does nothing for it.
- **A `name` index makes deep pages dramatically worse.** `OFFSET 99980` with the index
  is 1.8 s versus 266 ms without: the planner walks the index in order and does ~100k
  random heap fetches plus ~100k `EXISTS` probes to reach the offset, where the no-index
  plan does one seq scan and one sort. Offset paging is already the wrong tool for a deep
  page; the index sharpens the cliff rather than filing it down.
- **Filtered pages (`status` / `categoryId` / `low` / `out`) get nothing from it.** A
  `name` B-tree cannot satisfy those predicates — the plan still filters row by row — so
  the one screen state that would most want help when a catalogue is large (an Owner
  filtering to `status=low`) is the state the index does not touch.

**Decision: add no index.** The `name` orderings are not on the evidence bar — the same
conclusion Phase 11 §7, Phase 14 §7, and Phase 23 §7 each predicted this measurement
would reach. The index only earns its keep at ~100,000 catalogue rows (≈1,000× the
product's design point), only on the unfiltered first page, and at the cost of a
much steeper deep-page path and a second B-tree that every `products` / `suppliers`
`INSERT` and every `name` `UPDATE` must maintain forever.

### Fork A — "add it anyway, it's cheap." Rejected.

The index is `CREATE INDEX`, milliseconds to build, and small. The argument against is
this project's, not invented here: `architecture-observations.md`'s "what evidence to
look for" section and Phase 11 §7 both name "adding indexes because they might help" as
the specific speculation to refuse. An index with no read it accelerates at the current
or any plausible scale, a measured *negative* effect on the deep-page path, and a
standing write-side cost is not a free hedge — it is schema that a later reader has to
explain. The honest artifact is this measurement, so the next person crosses the bar with
a number instead of re-deriving the question.

### Fork B — a partial, covering, or expression index. Moot.

`(name) INCLUDE (…)`, `(status, name)`, `lower(name)` for the ILIKE search — each is a
refinement of an index the plain-index measurement already shows is unwarranted. If a
real deployment ever crosses into tens of thousands of catalogue rows, the re-measurement
should consider `(status, name)` specifically (it is the filtered-page case, the one a
plain `(name)` misses) — noted for that day, not built now.

### What would change this answer

A deployment whose `products` or `suppliers` table actually reaches several thousand
rows, *and* a paged catalogue read that shows up in a slow-request log. Re-run the
appendix script against the real table sizes. Until then the item moves off the "deferred,
trigger unfired" list and onto the record as **measured 2026-09-08, declined** — reopen
`issue #14` on evidence, not on a hunch.

---

## 2. What's new (backend)

**Nothing.** No dependency, no migration, no entity change, no service change, no DTO
change. The three DB registries (`database.module.ts`, `data-source.ts`,
`test-data-source.ts`) are untouched — stated because every schema-touching phase since
Phase 6 has had a line about them, and this is the first since then with nothing to say.

## 3. Frontend changes

**None.** No `frontend/` file changes; the `node --test` suite is not touched.

## 4. Documentation updates

1. **`docs/phase-24-plan.md`** — this file: the measurement, the decision, the
   reproducible script.
2. **`architecture-observations.md`** — a Phase 24 cross-cutting section: the catalogue
   `name` orderings were measured and left unindexed; `users` orders by its primary key
   and was always an index scan; the standing §7 conditional from Phases 11, 14, and 23
   is discharged with evidence rather than carried forward. Records that this is the
   first phase in the series to ship only a decision.
3. **`requirements.md`** — a "Catalogue Ordering Indexes (Phase 24 — no new FR, no schema
   change)" note beside the Phase 20–23 ones: no FR reads differently; there is no
   migration and no schema change; the deliverable is the measurement.
4. **`business-rules.md`** — a "**[2026-09-08, Phase 24]** No new BR" line: how a read is
   indexed is an implementation fact, never a rule about the business — the same reason
   the Phase 21 throttle-store change filed a "no new BR" line.
5. **`README.md`** — Current phase to Phase 24; Phase 23 moves to "Earlier phases". The
   entry notes there is no migration to run.
6. **`product.md` §11** — a Phase 24 cross-reference entry in the "no scope change" shape
   (no new user goal, no use case, no scope; issue #14 / Phase 11 §7 / Phase 14 §7
   named; Q-7 still open).
7. **`api.md`** — title and status line bumped to Phase 24 with an explicit "no API
   change"; no route, response, or parameter text changes.

## 5. Testing plan

**No new tests.** There is no code to pin. The measurement in §1 is the evidence, and
the appendix script reproduces it; it is deliberately not wired into the backend test
suites (it needs a large synthetic dataset and asserts on timing, neither of which
belongs in `jest --runInBand`). The full backend suite (20 unit/integration suites, 7
e2e) is unchanged and green — confirmed, since a doc-only phase that broke a test would
be a real regression (the Phase 11 §5 rule).

## 6. Rollout order

One step: land the documentation. Nothing to stage, nothing to de-risk, nothing that can
be "cut short".

## 7. Explicitly out of scope for Phase 24 (Future)

- **Any index on `products.name`, `suppliers.name`, or `categories.name`** — §1's
  decision. `categories` is not even in the issue (it is the smallest of the four tables,
  a few dozen rows at most) and the same measurement applies a fortiori.
- **`(status, name)` or a covering index** (Fork B) — the refinement to reconsider *if*
  a deployment ever crosses into tens of thousands of catalogue rows and a paged read
  goes slow. Named for that day.
- **`pg_trgm` / a GIN index for the `name ILIKE '%…%'` search** — the search predicate is
  unindexable by a plain B-tree and unaddressed here; a trigram index is a separate
  feature with its own extension dependency and its own trigger (a slow *search*, which
  nobody has reported). Phase 17's typeahead already caps that read at `pageSize=20`.
- **Indexing `inventory_transactions.type` / `.supplier_id`** — still unindexed, still on
  no capped read's path (Phase 11 §7's list, unchanged).
- **Replacing offset paging with keyset for the catalogue reads** — Phase 14 §1 chose
  offset deliberately (a `total` and random access, for a table a person grows a few
  times a week); §1's deep-page numbers here are a property of offset paging, not a new
  problem, and do not reopen that choice at this scale.
- **A committed performance-benchmark harness under `tools/`** — the appendix script is
  enough for a question asked once every several phases; a standing harness is
  infrastructure without a driver.
- **Q-4 follow-ons and Q-7 (multi-location)** — untouched, as in every phase since 5.

---

## 8. Definition of done

- [x] The Phase 14 paged catalogue query was `EXPLAIN (ANALYZE, BUFFERS)`-measured at
      200 / 1,000 / 10,000 / 100,000 rows, with and without a `name` index, for the first
      page, a deep page, and `getCount()` — numbers in §1, script in the appendix.
- [x] `users`: recorded that `ORDER BY id ASC` is served by the primary-key B-tree
      (`PK_a3ffb1c0c8416b9fc6f907b7433`) and always has been — no index to add.
- [x] `products.name` / `suppliers.name`: **no index added**, on the evidence that at the
      product's design scale the paged read is sub-millisecond, the DTO page cap pins the
      sort, `getCount()` and filtered pages are unhelped, and the index measurably worsens
      the deep-page path.
- [x] The standing conditional deferral in Phase 11 §7 / Phase 14 §7 / Phase 23 §7 is
      discharged: the item is recorded as *measured 2026-09-08, declined*, reopen on
      evidence.
- [x] No migration, no schema change, no entity/service/DTO change, no `frontend/` change,
      no domain-document change; the three DB registries untouched.
- [x] `architecture-observations.md` Phase 24 section; `requirements.md` and
      `business-rules.md` standing notes; `README.md`, `product.md` §11, and `api.md`
      phase pointers all updated.
- [x] Full backend suite green (20 unit/integration, 7 e2e) — unchanged by this phase.

---

## Appendix — the measurement script

Run from `backend/` against the dev database (or any Postgres); it uses only `TEMP`
tables and drops them. `NODE_PATH=./node_modules node explain-bench.js`.

```js
const { Client } = require('pg');
const SCALES = [200, 1000, 10000, 100000];
const PAGE = 20;

async function main() {
  const c = new Client({ host: '127.0.0.1', port: 55432, user: 'postgres', database: 'smart_inventory' });
  await c.connect();
  const q = async (sql) => (await c.query(sql)).rows;
  const explain = async (label, sql) => {
    const rows = await q('EXPLAIN (ANALYZE, BUFFERS, SUMMARY ON) ' + sql);
    console.log('\n### ' + label + '\n' + rows.map((r) => r['QUERY PLAN']).join('\n'));
  };
  await c.query('SET max_parallel_workers_per_gather = 0');

  for (const n of SCALES) {
    console.log('\n==================== SCALE: ' + n + ' ====================');
    await c.query('DROP TABLE IF EXISTS p; DROP TABLE IF EXISTS itx');
    await c.query(`CREATE TEMP TABLE p (
      id serial PRIMARY KEY, sku varchar NOT NULL, name varchar NOT NULL,
      unit varchar NOT NULL DEFAULT 'ea', category_id int, low_stock_threshold int,
      status varchar NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      current_stock int NOT NULL DEFAULT 0)`);
    await c.query(`INSERT INTO p (sku, name, category_id, low_stock_threshold, status, current_stock)
      SELECT 'SKU-'||g, md5(g::text)||' widget '||g, (g % 12) + 1,
             CASE WHEN g % 3 = 0 THEN (g % 50) END,
             CASE WHEN g % 20 = 0 THEN 'inactive' ELSE 'active' END, (g % 200) - 20
      FROM generate_series(1, ${n}) g`);
    await c.query('CREATE TEMP TABLE itx (id serial PRIMARY KEY, product_id int NOT NULL)');
    await c.query(`INSERT INTO itx (product_id) SELECT (g % ${n}) + 1 FROM generate_series(1, ${n * 3}) g`);
    await c.query('CREATE INDEX itx_pid ON itx (product_id)');
    await c.query('ANALYZE p; ANALYZE itx');

    const deep = Math.max(0, n - PAGE);
    const first = `SELECT p.*, EXISTS (SELECT 1 FROM itx WHERE itx.product_id = p.id) AS "hasHistory"
                   FROM p ORDER BY p.name ASC LIMIT ${PAGE} OFFSET 0`;
    const filtered = first.replace('ORDER BY', "WHERE p.status = 'active' AND p.category_id = 5 ORDER BY");
    for (const withIdx of [false, true]) {
      if (withIdx) { await c.query('CREATE INDEX p_name ON p (name)'); await c.query('ANALYZE p'); }
      const tag = withIdx ? 'WITH idx(name)' : 'NO idx';
      await explain(`[${n}] first page — ${tag}`, first);
      await explain(`[${n}] deep page OFFSET ${deep} — ${tag}`, first.replace('OFFSET 0', 'OFFSET ' + deep));
      await explain(`[${n}] filtered page — ${tag}`, filtered);
      if (!withIdx) await explain(`[${n}] getCount() — ${tag}`, 'SELECT COUNT(1) FROM p');
      if (withIdx) await c.query('DROP INDEX p_name');
    }
  }
  await c.query('DROP TABLE IF EXISTS p; DROP TABLE IF EXISTS itx');
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```
