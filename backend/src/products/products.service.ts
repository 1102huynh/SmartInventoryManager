import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdjustmentRequest } from '../adjustments/adjustment-request.entity';
import { AuditService } from '../audit/audit.service';
import { AdjustmentRequestStatus } from '../common/enums/adjustment-request-status.enum';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { InventoryService } from '../inventory/inventory.service';
import { Paged, pageEnvelope, resolvePaging } from '../common/pagination';
import {
  CURRENT_STOCK_EXPR,
  STOCK_AGG_ALIAS,
  joinCurrentStock,
} from '../inventory/stock-aggregate.query';
import { CreateProductDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Product } from './product.entity';

// The shape the UI mockup's Product List/Detail actually consume: the raw entity
// plus the two fields that only Inventory can compute. This is a plain return type,
// not a class — no validation involved, so it doesn't need to be a DTO the way
// request bodies do.
export interface ProductWithStock extends Product {
  currentStock: number;
  lowStock: boolean;
  outOfStock: boolean;
  hasHistory: boolean;
}

// The two computed columns `findAll`'s query adds via `addSelect`, read back off
// `getRawAndEntities` (Phase 14, Fork B).
interface RawStock {
  currentStock: string | number | null;
  hasHistory: boolean;
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(AdjustmentRequest)
    private readonly adjustmentRequestsRepository: Repository<AdjustmentRequest>,
    private readonly inventoryService: InventoryService,
    private readonly auditService: AuditService,
  ) {}

  async findAll(
    query: QueryProductsDto,
  ): Promise<ProductWithStock[] | Paged<ProductWithStock>> {
    // Built with the query builder rather than repository.find({ where }), because
    // "search name OR sku, AND status, AND category" mixes AND and OR — repository.find
    // only expresses that cleanly as an array of whole where-clauses (awkward here),
    // while the query builder lets andWhere/OR nest naturally.
    //
    // Phase 14 (docs/phase-14-plan.md §1 Fork B): current stock and `hasHistory` are
    // computed IN this query now — a grouped subquery join over inventory_transactions
    // (`IDX_2520d97de0c9a0fbfc9b00f4c1` on product_id backs the GROUP BY) — instead of
    // the two extra round-trips (`getCurrentStockMap` + `getHasHistoryMap`) this method
    // used to fire after `getMany`. That is what lets `low`/`out` become real WHERE
    // conditions below: `?status=low&pageSize=50` now pages the low-stock set, where
    // the old post-fetch `.filter()` would have taken 50 products by name and *then*
    // filtered (Phase 11 §1's failure mode). This runs whether or not paging is
    // active — one code path, a strict improvement even for the unpaged callers.
    //
    // Phase 19 (docs/phase-19-plan.md §1): the stock-aggregate join moved to a
    // shared helper so `DashboardService.getSummary` runs the identical query. The
    // `hasHistory` select and the low/out filters below are ProductsService's own —
    // they build on top of the helper's aggregate.
    const qb = joinCurrentStock(
      this.productsRepository.createQueryBuilder('product'),
    )
      // A GROUP BY row exists for a product iff it has at least one transaction — so
      // "the join matched" *is* hasHistory, including for a product whose deltas
      // happen to sum to zero.
      .addSelect(`${STOCK_AGG_ALIAS}.product_id IS NOT NULL`, 'hasHistory')
      .orderBy('product.name', 'ASC');
    if (query.status === 'active')
      qb.andWhere('product.status = :status', { status: EntityStatus.ACTIVE });
    if (query.status === 'inactive')
      qb.andWhere('product.status = :status', {
        status: EntityStatus.INACTIVE,
      });
    if (query.categoryId)
      qb.andWhere('product.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    if (query.search) {
      qb.andWhere('(product.name ILIKE :search OR product.sku ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }
    // Fork B: low/out are WHERE conditions over the in-query aggregate, not a
    // post-SQL `.filter()`. `outOfStock` is `currentStock <= 0` (a product with no
    // transactions is out of stock); `lowStock` needs a configured threshold —
    // BR-060/061's "null means never flagged".
    if (query.status === 'low')
      qb.andWhere(
        `product.low_stock_threshold IS NOT NULL AND ${CURRENT_STOCK_EXPR} <= product.low_stock_threshold`,
      );
    if (query.status === 'out') qb.andWhere(`${CURRENT_STOCK_EXPR} <= 0`);

    const paging = resolvePaging(query);
    if (!paging) {
      const { entities, raw } = await qb.getRawAndEntities<RawStock>();
      return this.mergeStock(entities, raw);
    }
    // Count the filtered set before the window is applied — `getCount` drops the
    // custom SELECT list, ORDER BY, and any limit/offset, keeping the joins and
    // WHERE, so `total` is the number of matches, not the page.
    const total = await qb.getCount();
    qb.offset(paging.skip).limit(paging.take);
    const { entities, raw } = await qb.getRawAndEntities<RawStock>();
    return pageEnvelope(this.mergeStock(entities, raw), total, paging);
  }

  // Re-attaches the in-query computed columns (index-aligned with the entities) onto
  // each Product, and derives `lowStock`/`outOfStock` from `currentStock` exactly as
  // `attachStock` does for the single-product reads. `currentStock` comes back from
  // `pg` as a numeric string (COALESCE over a bigint SUM); `hasHistory` as a real
  // boolean.
  private mergeStock(products: Product[], raw: RawStock[]): ProductWithStock[] {
    return products.map((product, i) => {
      const currentStock = Number(raw[i]?.currentStock ?? 0);
      const hasHistory = raw[i]?.hasHistory === true;
      const lowStock =
        product.lowStockThreshold !== null &&
        currentStock <= product.lowStockThreshold;
      return {
        ...product,
        currentStock,
        lowStock,
        outOfStock: currentStock <= 0,
        hasHistory,
      };
    });
  }

  async findOne(id: number): Promise<ProductWithStock> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found.`);
    const currentStock = await this.inventoryService.getCurrentStock(id);
    const hasHistory = await this.inventoryService.hasHistory(id);
    return this.attachStock(product, currentStock, hasHistory);
  }

  async create(dto: CreateProductDto, actorId: number): Promise<Product> {
    await this.assertSkuAvailable(dto.sku);
    const product = this.productsRepository.create({
      sku: dto.sku,
      name: dto.name,
      unit: dto.unit,
      categoryId: dto.categoryId ?? null,
      lowStockThreshold: dto.lowStockThreshold ?? null,
    });
    const saved = await this.productsRepository.save(product);
    await this.auditService.record({
      eventType: AuditEventType.PRODUCT_CREATED,
      actorUserId: actorId,
      entityType: AuditEntityType.PRODUCT,
      entityId: saved.id,
      summary: `Created "${saved.name}" (SKU ${saved.sku})`,
    });
    return saved;
  }

  async update(
    id: number,
    dto: UpdateProductDto,
    actorId: number,
  ): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found.`);
    const changes: string[] = [];

    if (dto.sku !== undefined && dto.sku !== product.sku) {
      // BR-001/FR-002: SKU identity is fixed once the product has any history.
      if (await this.inventoryService.hasHistory(id)) {
        throw new ConflictException(
          'This product has transaction history — its SKU can no longer be changed.',
        );
      }
      await this.assertSkuAvailable(dto.sku);
      changes.push(`SKU changed to ${dto.sku}`);
      product.sku = dto.sku;
    }

    if (dto.name !== product.name) changes.push(`Name changed to ${dto.name}`);
    product.name = dto.name;
    if (dto.unit !== product.unit) changes.push(`Unit changed to ${dto.unit}`);
    product.unit = dto.unit;
    if (dto.categoryId !== undefined && dto.categoryId !== product.categoryId) {
      changes.push('Category changed');
      product.categoryId = dto.categoryId;
    }
    if (
      dto.lowStockThreshold !== undefined &&
      dto.lowStockThreshold !== product.lowStockThreshold
    ) {
      changes.push(`Low-stock threshold changed to ${dto.lowStockThreshold}`);
      product.lowStockThreshold = dto.lowStockThreshold;
    }

    const saved = await this.productsRepository.save(product);
    if (changes.length > 0) {
      await this.auditService.record({
        eventType: AuditEventType.PRODUCT_UPDATED,
        actorUserId: actorId,
        entityType: AuditEntityType.PRODUCT,
        entityId: id,
        summary: changes.join('; '),
      });
    }
    return saved;
  }

  async setStatus(
    id: number,
    status: EntityStatus,
    actorId: number,
  ): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found.`);
    product.status = status;
    const saved = await this.productsRepository.save(product);
    await this.auditService.record({
      eventType: AuditEventType.PRODUCT_STATUS_CHANGED,
      actorUserId: actorId,
      entityType: AuditEntityType.PRODUCT,
      entityId: id,
      summary: status === EntityStatus.ACTIVE ? 'Reactivated' : 'Deactivated',
    });
    return saved;
  }

  async remove(id: number, actorId: number): Promise<void> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found.`);
    // BR-004/FR-006: no hard delete once any transaction exists — the RESTRICT
    // foreign key on inventory_transactions.product_id would reject this anyway,
    // but checking first gives a clear 409 instead of a raw DB constraint error.
    if (await this.inventoryService.hasHistory(id)) {
      throw new ConflictException(
        'This product has transaction history and cannot be deleted — deactivate it instead.',
      );
    }
    // BR-089 (Phase 12): adjustment_requests.product_id is RESTRICT for EVERY status,
    // not just `pending` — a withdrawn or rejected request against a product with no
    // transactions would otherwise sail past the BR-004 check above and then hit a raw
    // FK violation surfacing as a 500. Check all statuses here; the message
    // distinguishes a pending proposal (resolve or withdraw it) from a resolved one,
    // which is history in the same sense BR-004 means and gets the same "deactivate
    // instead" answer.
    const requestCount = await this.adjustmentRequestsRepository.count({
      where: { productId: id },
    });
    if (requestCount > 0) {
      const pendingCount = await this.adjustmentRequestsRepository.count({
        where: { productId: id, status: AdjustmentRequestStatus.PENDING },
      });
      throw new ConflictException(
        pendingCount > 0
          ? 'This product has a pending adjustment request — resolve or withdraw it before deleting.'
          : 'This product has adjustment request history and cannot be deleted — deactivate it instead.',
      );
    }
    await this.productsRepository.remove(product);
    // §1 "entity_id is deliberately NOT a foreign key": this row points at an id
    // that no longer exists in products the moment this write completes — that's the
    // entire point of recording it. Captured before remove() so the name is still in
    // hand for the summary.
    await this.auditService.record({
      eventType: AuditEventType.PRODUCT_DELETED,
      actorUserId: actorId,
      entityType: AuditEntityType.PRODUCT,
      entityId: id,
      summary: `Deleted "${product.name}" (SKU ${product.sku})`,
    });
  }

  private attachStock(
    product: Product,
    currentStock: number,
    hasHistory: boolean,
  ): ProductWithStock {
    const lowStock =
      product.lowStockThreshold !== null &&
      currentStock <= product.lowStockThreshold;
    return {
      ...product,
      currentStock,
      lowStock,
      outOfStock: currentStock <= 0,
      hasHistory,
    };
  }

  private async assertSkuAvailable(sku: string): Promise<void> {
    const existing = await this.productsRepository.findOne({ where: { sku } });
    if (existing)
      throw new ConflictException(`SKU "${sku}" is already in use.`);
  }
}
