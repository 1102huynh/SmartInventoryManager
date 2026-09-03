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

  async findAll(query: QueryProductsDto): Promise<ProductWithStock[]> {
    // Built with the query builder rather than repository.find({ where }), because
    // "search name OR sku, AND status, AND category" mixes AND and OR — repository.find
    // only expresses that cleanly as an array of whole where-clauses (awkward here),
    // while the query builder lets andWhere/OR nest naturally.
    const qb = this.productsRepository
      .createQueryBuilder('product')
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
    const products = await qb.getMany();

    const ids = products.map((p) => p.id);
    const [stockMap, historyMap] = await Promise.all([
      this.inventoryService.getCurrentStockMap(ids),
      this.inventoryService.getHasHistoryMap(ids),
    ]);
    let withStock = products.map((p) =>
      this.attachStock(
        p,
        stockMap.get(p.id) ?? 0,
        historyMap.get(p.id) ?? false,
      ),
    );

    // low/out depend on a *computed* value (threshold vs. current stock), so they're
    // filtered here in application code rather than in the SQL WHERE clause above.
    if (query.status === 'low') withStock = withStock.filter((p) => p.lowStock);
    if (query.status === 'out')
      withStock = withStock.filter((p) => p.outOfStock);
    return withStock;
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
