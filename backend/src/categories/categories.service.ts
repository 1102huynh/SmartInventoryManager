import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  ) {}

  findAll(): Promise<Category[]> {
    return this.categoriesRepository.find({ order: { name: 'ASC' } });
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    await this.assertNameAvailable(dto.name);
    const category = this.categoriesRepository.create({ name: dto.name });
    return this.categoriesRepository.save(category);
  }

  async update(id: number, dto: UpdateCategoryDto): Promise<Category> {
    const category = await this.findOneOrThrow(id);
    if (dto.name !== undefined && dto.name !== category.name) {
      await this.assertNameAvailable(dto.name);
      category.name = dto.name;
    }
    return this.categoriesRepository.save(category);
  }

  // FR-005/§1 "Delete is a real delete, not a soft-delete-with-history-guard": unlike
  // ProductsService.remove, there is deliberately no hasHistory-style check here — a
  // Category has no transactions of its own, and products.category_id's FK is
  // ON DELETE SET NULL (see the InitSchema migration), so any product currently
  // pointing at this category is orphaned back to "Uncategorized" by the database
  // itself. Building a guard here would silently contradict that schema decision.
  async remove(id: number): Promise<void> {
    const category = await this.findOneOrThrow(id);
    await this.categoriesRepository.remove(category);
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
