import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    private readonly inventoryService: InventoryService,
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

  async create(dto: CreateProductDto): Promise<Product> {
    await this.assertSkuAvailable(dto.sku);
    const product = this.productsRepository.create({
      sku: dto.sku,
      name: dto.name,
      unit: dto.unit,
      categoryId: dto.categoryId ?? null,
      lowStockThreshold: dto.lowStockThreshold ?? null,
    });
    return this.productsRepository.save(product);
  }

  async update(id: number, dto: UpdateProductDto): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found.`);

    if (dto.sku !== undefined && dto.sku !== product.sku) {
      // BR-001/FR-002: SKU identity is fixed once the product has any history.
      if (await this.inventoryService.hasHistory(id)) {
        throw new ConflictException(
          'This product has transaction history — its SKU can no longer be changed.',
        );
      }
      await this.assertSkuAvailable(dto.sku);
      product.sku = dto.sku;
    }

    product.name = dto.name;
    product.unit = dto.unit;
    if (dto.categoryId !== undefined) product.categoryId = dto.categoryId;
    if (dto.lowStockThreshold !== undefined)
      product.lowStockThreshold = dto.lowStockThreshold;
    return this.productsRepository.save(product);
  }

  async setStatus(id: number, status: EntityStatus): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found.`);
    product.status = status;
    return this.productsRepository.save(product);
  }

  async remove(id: number): Promise<void> {
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
    await this.productsRepository.remove(product);
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
