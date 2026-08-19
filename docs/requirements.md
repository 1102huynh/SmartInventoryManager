# Functional Requirements — Smart Inventory Manager

Status: Phase 0 — Product & Business Analysis
Last updated: 2026-08-19

Priority legend: **Must** (MVP), **Should** (near-term, non-blocking), **Future** (postponed).
See `product.md` for scope rationale and `business-rules.md` for the rules each requirement
must satisfy.

## Product Management

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-001 | Create product | User can create a product with a name, unique identifier (SKU), and unit of measurement. | Must | See BR-001, BR-003 |
| FR-002 | Edit product | User can edit a product's editable details (name, threshold, category, etc.). SKU identity should not be freely changeable once transactions exist. | Must | See BR-001 |
| FR-003 | Activate / deactivate product | User can mark a product Active or Inactive. Inactive products are excluded from new stock-in/out transactions. | Must | See BR-002 |
| FR-004 | View product list & detail | User can view all products with current stock and status, and drill into a single product's detail. | Must | Detail view links to FR-030 (history) |
| FR-005 | Categorize product | User can optionally assign a product to a category for organization/filtering. | Should | Q-5: flat vs hierarchical categories |
| FR-006 | Prevent product deletion with history | Products that have transaction history cannot be hard-deleted, only deactivated. | Must | See BR-004 |

## Supplier Management

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-010 | Create supplier | User can create a supplier with a name and contact information. | Should | |
| FR-011 | Edit supplier | User can edit supplier details. | Should | |
| FR-012 | View supplier list & detail | User can view all suppliers and see stock-in history associated with a supplier. | Should | |
| FR-013 | Activate / deactivate supplier | User can mark a supplier Active or Inactive; inactive suppliers cannot be selected for new stock-in. | Should | Mirrors FR-003 |

## Inventory Management — Stock In

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-020 | Record stock-in | User can record receipt of a product: product, quantity, date, and (if supplier tracking is enabled) supplier. Increases current stock. | Must | See BR-010–BR-013. Q-2: supplier optional/mandatory |

## Inventory Management — Stock Out

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-021 | Record stock-out | User can record removal of a product: product, quantity, date, and optional reason. Decreases current stock; cannot exceed current stock. | Must | See BR-020–BR-022. Q-4: sale vs. generic removal |

## Inventory Management — Adjustment

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-022 | Record inventory adjustment | User can record a stock correction (increase or decrease) with a mandatory reason, used to reconcile actual counts with system records. | Must | See BR-030–BR-034 |

## Current Stock

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-023 | View current stock | User can see the current stock quantity for any product. | Must | See BR-040–BR-042 |
| FR-024 | Derive current stock from transactions | Current stock is always computed from (or kept consistent with) the full transaction history — it is never edited directly. | Must | See BR-040 |

## Inventory History

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-030 | View product transaction history | User can view the chronological list of all stock-in, stock-out, and adjustment transactions for a given product. | Must | See BR-050, BR-051 |
| FR-031 | View global transaction log | User can view all inventory transactions across all products, e.g. for a recent-activity view. | Should | Feeds dashboard (FR-050) |

## Low Stock

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-040 | Configure low-stock threshold | User can set a low-stock threshold per product. | Must | Q-3: per-product vs. global default |
| FR-041 | Detect low-stock products | System flags a product as low-stock when current stock falls at or below its threshold. | Must | See BR-060, BR-061 |
| FR-042 | View low-stock list | User can view the list of all products currently flagged as low-stock. | Must | Feeds dashboard (FR-050) |

## Dashboard

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-050 | Dashboard summary | User sees a summary view on entry: total active products, count of low-stock products, and recent transaction activity. | Should | Composed from FR-004, FR-031, FR-042; no new data of its own |

## User Attribution

| ID | Name | Description | Priority | Notes / Assumptions |
|---|---|---|---|---|
| FR-060 | User login | A user must authenticate to use the system. | Must | Minimal auth; RBAC deferred (A-5) |
| FR-061 | Attribute transactions to user | Every stock-in, stock-out, and adjustment records which user performed it. | Must | Supports auditability, BR-050 |

## Cross-Reference Summary

```
FR-020 (stock-in)      → BR-010, BR-011, BR-012, BR-013 → Inventory Transaction / Supplier
FR-021 (stock-out)     → BR-020, BR-021, BR-022         → Inventory Transaction
FR-022 (adjustment)    → BR-030, BR-031, BR-032, BR-033, BR-034 → Inventory Transaction
FR-023/024 (current stock) → BR-040, BR-041, BR-042     → Product / Inventory Transaction
FR-030/031 (history)   → BR-050, BR-051                 → Inventory Transaction
FR-040/041/042 (low stock) → BR-060, BR-061              → Product
```
