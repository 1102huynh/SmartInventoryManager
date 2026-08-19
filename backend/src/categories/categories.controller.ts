import { Controller, Get } from '@nestjs/common';
import { CategoriesService } from './categories.service';

// @Controller('categories') means every route method below is mounted under
// /categories. The controller itself never talks to the database — it just calls
// the service and returns what it gets back; Nest serializes the return value to
// JSON automatically.
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }
}
