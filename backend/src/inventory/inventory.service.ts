import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { TransactionType } from '../common/enums/transaction-type.enum';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CreateStockInDto } from './dto/create-stock-in.dto';
import { CreateStockOutDto } from './dto/create-stock-out.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { InventoryTransaction } from './inventory-transaction.entity';

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

  listForProduct(productId: number): Promise<InventoryTransaction[]> {
    return this.transactionsRepository.find({
      where: { productId },
      relations: { supplier: true, recordedBy: true },
      order: { occurredAt: 'DESC' },
    });
  }

  listAll(query: QueryTransactionsDto): Promise<InventoryTransaction[]> {
    const qb = this.transactionsRepository
      .createQueryBuilder('tx')
      .leftJoinAndSelect('tx.product', 'product')
      .leftJoinAndSelect('tx.supplier', 'supplier')
      .leftJoinAndSelect('tx.recordedBy', 'recordedBy')
      .orderBy('tx.occurredAt', 'DESC');

    if (query.type) qb.andWhere('tx.type = :type', { type: query.type });
    if (query.productId)
      qb.andWhere('tx.productId = :productId', { productId: query.productId });
    if (query.supplierId)
      qb.andWhere('tx.supplierId = :supplierId', {
        supplierId: query.supplierId,
      });
    if (query.days) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - query.days);
      qb.andWhere('tx.occurredAt >= :cutoff', { cutoff });
    }
    return qb.getMany();
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
    return this.dataSource.transaction(async (manager) => {
      // Unlike stock-in/out, adjustment is intentionally allowed on an inactive
      // product (see docs/ui-open-questions.md Q-UI-1) — a discontinued product may
      // still need a final correcting count — so this does NOT use
      // getLockedActiveProduct; it locks the row without checking status.
      const product = await manager.getRepository(Product).findOne({
        where: { id: productId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!product)
        throw new NotFoundException(`Product ${productId} not found.`);

      const currentStock = await this.getCurrentStockLocked(
        manager,
        product.id,
      );
      const delta = dto.newQuantity - currentStock;
      if (delta === 0) {
        throw new BadRequestException(
          'The counted quantity matches current stock — no adjustment needed.',
        );
      }

      return this.insertTransaction(manager, {
        productId: product.id,
        type: TransactionType.ADJUSTMENT,
        quantityDelta: delta,
        occurredAt: dto.occurredAt,
        userId,
        supplierId: null,
        reason: dto.reason,
      });
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
      occurredAt: string;
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

  private assertNotFuture(dateStr: string): void {
    const date = new Date(dateStr);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (date > today)
      throw new BadRequestException('Date cannot be in the future.');
  }
}
