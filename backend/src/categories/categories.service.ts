import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
}
