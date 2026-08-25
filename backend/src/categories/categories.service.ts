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
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Category } from './category.entity';

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

  findAll(): Promise<Category[]> {
    return this.categoriesRepository.find({ order: { name: 'ASC' } });
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
