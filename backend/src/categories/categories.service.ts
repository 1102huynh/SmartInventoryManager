import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { Paged, pageEnvelope, resolvePaging } from '../common/pagination';
import { Product } from '../products/product.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { QueryCategoriesDto } from './dto/query-categories.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Category } from './category.entity';

// Phase 17 (docs/phase-17-plan.md §2): the paged `findAll` attaches a `productCount`
// to each row. A plain return type, not a DTO — nothing is validated — the same call
// `ProductWithStock` makes in products.service.ts.
export interface CategoryWithCount extends Category {
  productCount: number;
}

// The computed column the paged query adds via `addSelect`, read back off
// `getRawAndEntities` (Phase 17, the Phase 14 Fork B pattern).
interface RawCount {
  productCount: string | number | null;
}

@Injectable()
export class CategoriesService {
  // @InjectRepository(Category) tells Nest's DI container "give me the Repository
  // TypeORM built for the Category entity". We never call `new Repository(...)`
  // ourselves — Nest constructs it once and hands the same instance to anything
  // that asks, which is what makes this a "provider" rather than a plain class.
  constructor(
    @InjectRepository(Category)
    private readonly categoriesRepository: Repository<Category>,
    private readonly auditService: AuditService,
  ) {}

  // Phase 14 (docs/phase-14-plan.md §1): optional `page`/`pageSize` (the DTO is new
  // this phase — this method took no argument before). Omitted — the case
  // `Store.loadReferenceData` hits to fill the `CATEGORIES` cache — it returns every
  // category, alphabetical, exactly as before: a bare `Category[]` with no computed
  // fields.
  //
  // Phase 17 (docs/phase-17-plan.md §2): the *paged* branch — only ever reached by the
  // Categories admin screen — now also carries `productCount` per row, so that screen
  // stops fetching the whole product catalogue just to count client-side (issue #7,
  // one of Phase 14 §1's "second consumer" reads). The count is computed in the query
  // via a grouped subquery join over `products` and read back off `getRawAndEntities`
  // — the pattern Phase 14 Fork B established in `ProductsService.findAll`. The
  // no-param branch is deliberately left untouched: the reference cache never needs
  // the count and its bare-array shape is a contract every product form's dropdown
  // relies on.
  async findAll(
    query: QueryCategoriesDto = {},
  ): Promise<Category[] | Paged<CategoryWithCount>> {
    const order = { name: 'ASC' as const };
    const paging = resolvePaging(query);
    if (!paging) return this.categoriesRepository.find({ order });

    // Categories carry no filter (no search, no status), so `total` is the whole
    // table — a plain COUNT, not a `getCount()` over the joined builder.
    const total = await this.categoriesRepository.count();
    const { entities, raw } = await this.categoriesRepository
      .createQueryBuilder('category')
      .leftJoin(
        (sub) =>
          sub
            .select('product.category_id', 'category_id')
            .addSelect('COUNT(*)', 'count')
            .from(Product, 'product')
            .groupBy('product.category_id'),
        'product_agg',
        'product_agg.category_id = category.id',
      )
      .addSelect('COALESCE(product_agg.count, 0)', 'productCount')
      .orderBy('category.name', 'ASC')
      .offset(paging.skip)
      .limit(paging.take)
      .getRawAndEntities<RawCount>();

    const items: CategoryWithCount[] = entities.map((category, i) => ({
      ...category,
      // pg returns COUNT(*) as a bigint string.
      productCount: Number(raw[i]?.productCount ?? 0),
    }));
    return pageEnvelope(items, total, paging);
  }

  async create(dto: CreateCategoryDto, actorId: number): Promise<Category> {
    await this.assertNameAvailable(dto.name);
    const category = this.categoriesRepository.create({ name: dto.name });
    const saved = await this.categoriesRepository.save(category);
    await this.auditService.record({
      eventType: AuditEventType.CATEGORY_CREATED,
      actorUserId: actorId,
      entityType: AuditEntityType.CATEGORY,
      entityId: saved.id,
      summary: `Created "${saved.name}"`,
    });
    return saved;
  }

  async update(
    id: number,
    dto: UpdateCategoryDto,
    actorId: number,
  ): Promise<Category> {
    const category = await this.findOneOrThrow(id);
    if (dto.name !== undefined && dto.name !== category.name) {
      await this.assertNameAvailable(dto.name);
      const oldName = category.name;
      category.name = dto.name;
      const saved = await this.categoriesRepository.save(category);
      await this.auditService.record({
        eventType: AuditEventType.CATEGORY_UPDATED,
        actorUserId: actorId,
        entityType: AuditEntityType.CATEGORY,
        entityId: id,
        summary: `Renamed from "${oldName}" to "${dto.name}"`,
      });
      return saved;
    }
    return this.categoriesRepository.save(category);
  }

  // FR-005/§1 "Delete is a real delete, not a soft-delete-with-history-guard": unlike
  // ProductsService.remove, there is deliberately no hasHistory-style check here — a
  // Category has no transactions of its own, and products.category_id's FK is
  // ON DELETE SET NULL (see the InitSchema migration), so any product currently
  // pointing at this category is orphaned back to "Uncategorized" by the database
  // itself. Building a guard here would silently contradict that schema decision.
  async remove(id: number, actorId: number): Promise<void> {
    const category = await this.findOneOrThrow(id);
    await this.categoriesRepository.remove(category);
    // §1 "entity_id is deliberately NOT a foreign key": this row points at an id
    // that no longer exists in categories the moment this write completes.
    await this.auditService.record({
      eventType: AuditEventType.CATEGORY_DELETED,
      actorUserId: actorId,
      entityType: AuditEntityType.CATEGORY,
      entityId: id,
      summary: `Deleted "${category.name}"`,
    });
  }

  private async findOneOrThrow(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
    });
    if (!category) throw new NotFoundException(`Category ${id} not found.`);
    return category;
  }

  private async assertNameAvailable(name: string): Promise<void> {
    const existing = await this.categoriesRepository.findOne({
      where: { name },
    });
    if (existing)
      throw new ConflictException(`Category "${name}" already exists.`);
  }
}
