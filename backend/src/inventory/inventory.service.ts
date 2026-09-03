import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { daysCutoffForDateColumn } from '../common/days-cutoff';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { TransactionType } from '../common/enums/transaction-type.enum';
import { BoundedResult, trimToLimit } from '../common/result-truncated.header';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CreateStockInDto } from './dto/create-stock-in.dto';
import { CreateStockOutDto } from './dto/create-stock-out.dto';
import { QueryProductTransactionsDto } from './dto/query-product-transactions.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { InventoryTransaction } from './inventory-transaction.entity';

// Phase 11 (docs/phase-11-plan.md §1 "Configuration or constants: constants, following
// Phase 9"). Copies AuditService's `const DEFAULT_LIMIT = 100` exactly — no
// configuration.ts entry, no .env.example line: no deployment tunes a page size, and
// the tests set `limit` per request through the query string. The ceiling (500) is
// @Max(500) in the two query DTOs, validation rather than a clamp.
const DEFAULT_LIMIT = 100;

// Phase 12 (docs/phase-12-plan.md §1 "The zero-delta case can arrive by drift"). The
// one message text for "the count you entered now equals current stock, so there is
// nothing to adjust". Shared so the immediate path and the approval path say the same
// sentence — they differ only in the HTTP status that carries it: the immediate path
// keeps its pre-phase 400 (a malformed request — you asked for a no-op), the approval
// path returns 409 (a conflict with state that changed under you between request and
// approval). See AdjustmentsService.resolve.
export const NO_OP_ADJUSTMENT_MESSAGE =
  'The counted quantity matches current stock — no adjustment needed.';

// The internal shape both list reads return: the rows the caller asked for, plus
// whether the database had more. The controller turns `truncated` into a response
// header and returns `rows` — HTTP knowledge stays out of the service, and callers
// that only want the rows (DashboardService) read `.rows`. The trimming rule itself is
// shared with AuditService (common/result-truncated.header.ts), not repeated here.
export type BoundedTransactions = BoundedResult<InventoryTransaction>;

@Injectable()
export class InventoryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(InventoryTransaction)
    private readonly transactionsRepository: Repository<InventoryTransaction>,
  ) {}

  // ---------------------------------------------------------------- Reads --

  // BR-040: current stock is SUM(quantity_delta) for the product, computed on demand
  // — never a stored column (see the comment on Product.currentStock's absence).
  // COALESCE handles a product with zero transactions, where SUM() would otherwise
  // return SQL NULL instead of 0.
  async getCurrentStock(productId: number): Promise<number> {
    const raw = await this.transactionsRepository
      .createQueryBuilder('tx')
      .select('COALESCE(SUM(tx.quantityDelta), 0)', 'sum')
      .where('tx.productId = :productId', { productId })
      .getRawOne<{ sum: string }>();
    return parseInt(raw?.sum ?? '0', 10);
  }

  // Used by ProductsService.findAll to avoid an N+1 query (one aggregate per product)
  // when listing many products — one GROUP BY query instead, then an in-memory lookup.
  async getCurrentStockMap(productIds: number[]): Promise<Map<number, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.transactionsRepository
      .createQueryBuilder('tx')
      .select('tx.productId', 'productId')
      .addSelect('SUM(tx.quantityDelta)', 'sum')
      .where('tx.productId IN (:...productIds)', { productIds })
      .groupBy('tx.productId')
      .getRawMany<{ productId: number; sum: string }>();
    const map = new Map(productIds.map((id) => [id, 0]));
    rows.forEach((row) => map.set(row.productId, parseInt(row.sum, 10)));
    return map;
  }

  // BR-004: a product can only be hard-deleted if it was never used in a transaction.
  async hasHistory(productId: number): Promise<boolean> {
    const count = await this.transactionsRepository.count({
      where: { productId },
    });
    return count > 0;
  }

  // Batched sibling of hasHistory, for ProductsService.findAll — the frontend needs
  // to know this per product (to lock the SKU field and gate the Delete button), same
  // N+1-avoidance reasoning as getCurrentStockMap.
  async getHasHistoryMap(productIds: number[]): Promise<Map<number, boolean>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.transactionsRepository
      .createQueryBuilder('tx')
      .select('DISTINCT tx.productId', 'productId')
      .where('tx.productId IN (:...productIds)', { productIds })
      .getRawMany<{ productId: number }>();
    const withHistory = new Set(rows.map((r) => r.productId));
    return new Map(productIds.map((id) => [id, withHistory.has(id)]));
  }

  // Phase 11 (docs/phase-11-plan.md §1). Bounded, newest-first, no offset pagination.
  //
  // The ordering is `occurred_at DESC, id DESC`, not `occurred_at DESC` alone, and
  // the `id` tie-break is the sharpest point of the phase: occurred_at comes from
  // <input type="date">, so every row recorded for one business day is byte-identical
  // in it, and a LIMIT over a non-total order returns an arbitrary subset — refreshing
  // the screen would shuffle which of today's movements show. `id` is the PRIMARY KEY,
  // so the composite is total by construction, and it also happens to be insertion
  // order within a day. Backed by IDX_inventory_transactions_occurred_at_id.
  //
  // Truncation is observable without a COUNT(*): ask for `limit + 1`, return `limit`,
  // and report whether the extra row existed. `limit == matched` returns the full set
  // with truncated=false — the extra row was asked for and genuinely did not exist.
  async listForProduct(
    productId: number,
    query: QueryProductTransactionsDto,
  ): Promise<BoundedTransactions> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    // Moved from repository.find to the query builder so `take` and `addOrderBy` read
    // the same way as listAll; the joined relations are the same two find() loaded
    // (supplier, recordedBy) — not product, which the caller already has.
    const rows = await this.transactionsRepository
      .createQueryBuilder('tx')
      .leftJoinAndSelect('tx.supplier', 'supplier')
      .leftJoinAndSelect('tx.recordedBy', 'recordedBy')
      .where('tx.productId = :productId', { productId })
      .orderBy('tx.occurredAt', 'DESC')
      .addOrderBy('tx.id', 'DESC')
      .take(limit + 1)
      .getMany();
    return trimToLimit(rows, limit);
  }

  async listAll(query: QueryTransactionsDto): Promise<BoundedTransactions> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const qb = this.transactionsRepository
      .createQueryBuilder('tx')
      .leftJoinAndSelect('tx.product', 'product')
      .leftJoinAndSelect('tx.supplier', 'supplier')
      .leftJoinAndSelect('tx.recordedBy', 'recordedBy')
      .orderBy('tx.occurredAt', 'DESC')
      .addOrderBy('tx.id', 'DESC')
      .take(limit + 1);

    if (query.type) qb.andWhere('tx.type = :type', { type: query.type });
    if (query.productId)
      qb.andWhere('tx.productId = :productId', { productId: query.productId });
    if (query.supplierId)
      qb.andWhere('tx.supplierId = :supplierId', {
        supplierId: query.supplierId,
      });
    if (query.days) {
      qb.andWhere('tx.occurredAt >= :cutoff', {
        cutoff: daysCutoffForDateColumn(query.days),
      });
    }
    return trimToLimit(await qb.getMany(), limit);
  }

  // Phase 11 (docs/phase-11-plan.md §2). Replaces DashboardService's second full read
  // of the transaction table (`listAll({ days: 7 }).length`) — a COUNT(*) with the
  // same cutoff, no joins, no rows materialised. Only the mechanism changed (a full
  // read became a count); the window it counts is the calendar window defined by
  // daysCutoffForDateColumn (common/days-cutoff.ts).
  countSince(days: number): Promise<number> {
    return this.transactionsRepository
      .createQueryBuilder('tx')
      .where('tx.occurredAt >= :cutoff', {
        cutoff: daysCutoffForDateColumn(days),
      })
      .getCount();
  }

  // ------------------------------------------------------------ Writes --
  //
  // All three writers below share the same shape, and it matters that they do:
  //
  //   1. Open a database transaction.
  //   2. Lock the product row (SELECT ... FOR UPDATE) — this is what stops two
  //      concurrent requests for the SAME product from both reading "current stock
  //      = 10" and both deciding an 8-unit stock-out is safe, overselling to -6.
  //      A second concurrent request simply waits for the lock, then sees the
  //      first request's committed change before it reads current stock itself.
  //   3. Compute current stock *inside* that same transaction/lock.
  //   4. Validate the business rule against that number.
  //   5. Insert the new transaction row.
  //   6. Commit — releasing the lock.
  //
  // Application-layer validation alone (read stock, check in JS, then write) cannot
  // prevent the race above; only a database-level lock held for the duration of the
  // check-and-write can. See docs/learning-notes/database-transactions.md.

  async recordStockIn(
    productId: number,
    dto: CreateStockInDto,
    userId: number,
  ): Promise<InventoryTransaction> {
    this.assertNotFuture(dto.occurredAt);
    return this.dataSource.transaction(async (manager) => {
      const product = await this.getLockedActiveProduct(manager, productId);
      if (dto.supplierId)
        await this.assertSupplierUsable(manager, dto.supplierId);

      return this.insertTransaction(manager, {
        productId: product.id,
        type: TransactionType.STOCK_IN,
        quantityDelta: dto.quantity,
        occurredAt: dto.occurredAt,
        userId,
        supplierId: dto.supplierId ?? null,
        reason: null,
      });
    });
  }

  async recordStockOut(
    productId: number,
    dto: CreateStockOutDto,
    userId: number,
  ): Promise<InventoryTransaction> {
    this.assertNotFuture(dto.occurredAt);
    return this.dataSource.transaction(async (manager) => {
      const product = await this.getLockedActiveProduct(manager, productId);
      const currentStock = await this.getCurrentStockLocked(
        manager,
        product.id,
      );

      // BR-021: cannot reduce stock below zero.
      if (dto.quantity > currentStock) {
        throw new ConflictException(
          `Only ${currentStock} ${product.unit} available — cannot remove ${dto.quantity}.`,
        );
      }

      return this.insertTransaction(manager, {
        productId: product.id,
        type: TransactionType.STOCK_OUT,
        quantityDelta: -dto.quantity,
        occurredAt: dto.occurredAt,
        userId,
        supplierId: null,
        reason: dto.reason ?? null,
      });
    });
  }

  async recordAdjustment(
    productId: number,
    dto: CreateAdjustmentDto,
    userId: number,
  ): Promise<InventoryTransaction> {
    this.assertNotFuture(dto.occurredAt);
    try {
      return await this.dataSource.transaction((manager) =>
        this.applyApprovedAdjustment(manager, {
          productId,
          newQuantity: dto.newQuantity,
          occurredAt: dto.occurredAt,
          userId,
          reason: dto.reason,
        }),
      );
    } catch (err) {
      // The immediate path has always answered a no-op adjustment with 400, not 409
      // (docs/ui-open-questions.md Q-UI-2 flow) — keep that. applyApprovedAdjustment
      // throws ConflictException for the approval path's benefit; translate just that
      // one case back here so the Owner path is byte-identical to pre-phase.
      if (
        err instanceof ConflictException &&
        err.message === NO_OP_ADJUSTMENT_MESSAGE
      ) {
        throw new BadRequestException(NO_OP_ADJUSTMENT_MESSAGE);
      }
      throw err;
    }
  }

  // Phase 12 (docs/phase-12-plan.md §2). recordAdjustment's body, minus the
  // transaction it opens: this takes an EntityManager from the caller so an
  // AdjustmentsService approval can insert the transaction row AND flip the request to
  // `approved` inside one database transaction — or neither. recordAdjustment above is
  // now just "open a transaction, then call this", so the immediate path and the
  // approved path share one implementation of the lock, the delta computation, the
  // zero-delta check, and the insert. Two code paths that must produce identical rows
  // should not be two pieces of code.
  //
  // `userId` is the acting user, passed explicitly: an approved adjustment's
  // transaction is attributed to the REQUESTER (the person who counted the stock and
  // typed the number), not the approver (BR-088). The approver is recorded on the
  // request, reachable from the transaction by resulting_transaction_id.
  //
  // BR-052 (occurredAt not in the future) is NOT re-checked here — it was validated
  // when the request was submitted and a past date does not become a future one. The
  // immediate path checks it in recordAdjustment before opening its transaction.
  async applyApprovedAdjustment(
    manager: EntityManager,
    params: {
      productId: number;
      newQuantity: number;
      occurredAt: string | Date;
      userId: number;
      reason: string;
    },
  ): Promise<InventoryTransaction> {
    // Unlike stock-in/out, adjustment is intentionally allowed on an inactive
    // product (see docs/ui-open-questions.md Q-UI-1) — a discontinued product may
    // still need a final correcting count — so this does NOT use
    // getLockedActiveProduct; it locks the row without checking status.
    const product = await manager.getRepository(Product).findOne({
      where: { id: params.productId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!product)
      throw new NotFoundException(`Product ${params.productId} not found.`);

    const currentStock = await this.getCurrentStockLocked(manager, product.id);
    const delta = params.newQuantity - currentStock;
    if (delta === 0) {
      throw new ConflictException(NO_OP_ADJUSTMENT_MESSAGE);
    }

    return this.insertTransaction(manager, {
      productId: product.id,
      type: TransactionType.ADJUSTMENT,
      quantityDelta: delta,
      occurredAt: params.occurredAt,
      userId: params.userId,
      supplierId: null,
      reason: params.reason,
    });
  }

  // ------------------------------------------------------------- Helpers --

  private async getLockedActiveProduct(
    manager: EntityManager,
    productId: number,
  ): Promise<Product> {
    const product = await manager.getRepository(Product).findOne({
      where: { id: productId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!product)
      throw new NotFoundException(`Product ${productId} not found.`);
    // BR-013 / domain-model.md invariant: stock-in/out is blocked on an inactive product.
    if (product.status !== EntityStatus.ACTIVE) {
      throw new ConflictException(
        'Inactive products cannot receive stock-in or stock-out transactions.',
      );
    }
    return product;
  }

  // Reads current stock using the SAME EntityManager as the row lock above, so it
  // runs inside that transaction and sees a consistent, serialized view.
  private async getCurrentStockLocked(
    manager: EntityManager,
    productId: number,
  ): Promise<number> {
    const raw = await manager
      .createQueryBuilder(InventoryTransaction, 'tx')
      .select('COALESCE(SUM(tx.quantityDelta), 0)', 'sum')
      .where('tx.productId = :productId', { productId })
      .getRawOne<{ sum: string }>();
    return parseInt(raw?.sum ?? '0', 10);
  }

  private async assertSupplierUsable(
    manager: EntityManager,
    supplierId: number,
  ): Promise<void> {
    const supplier = await manager
      .getRepository(Supplier)
      .findOne({ where: { id: supplierId } });
    if (!supplier)
      throw new NotFoundException(`Supplier ${supplierId} not found.`);
    // FR-013: an inactive supplier can't be selected for a NEW stock-in — it can
    // still appear on transactions recorded before it was deactivated.
    if (supplier.status !== EntityStatus.ACTIVE) {
      throw new ConflictException(
        'Inactive suppliers cannot be selected for a new stock-in.',
      );
    }
  }

  private insertTransaction(
    manager: EntityManager,
    values: {
      productId: number;
      type: TransactionType;
      quantityDelta: number;
      occurredAt: string | Date;
      userId: number;
      supplierId: number | null;
      reason: string | null;
    },
  ): Promise<InventoryTransaction> {
    const repo = manager.getRepository(InventoryTransaction);
    const record = repo.create({
      productId: values.productId,
      type: values.type,
      quantityDelta: values.quantityDelta,
      occurredAt: new Date(values.occurredAt),
      recordedByUserId: values.userId,
      supplierId: values.supplierId,
      reason: values.reason,
    });
    return repo.save(record);
  }

  // Public since Phase 12: AdjustmentsService calls this to enforce BR-052 when a
  // Staff member SUBMITS an adjustment request, so the check happens once — at
  // submission — and is deliberately not repeated at approval (a past date does not
  // become a future one; docs/phase-12-plan.md §1).
  assertNotFuture(dateStr: string): void {
    const date = new Date(dateStr);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (date > today)
      throw new BadRequestException('Date cannot be in the future.');
  }
}
