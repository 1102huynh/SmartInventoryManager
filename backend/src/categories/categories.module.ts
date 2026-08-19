import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { Category } from './category.entity';

// TypeOrmModule.forFeature([Category]) is what actually registers Repository<Category>
// as an injectable provider *within this module's scope* — forRootAsync (in
// DatabaseModule) only established the database connection itself. Every feature
// module that needs a repository imports TypeOrmModule.forFeature with its own
// entity/entities.
//
// exports: [CategoriesService] lets other modules (Products, once it needs to
// validate a categoryId) inject CategoriesService by importing CategoriesModule —
// without an export, a provider is private to the module that declares it.
@Module({
  imports: [TypeOrmModule.forFeature([Category])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
