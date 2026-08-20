import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

// @Controller('categories') means every route method below is mounted under
// /categories. The controller itself never talks to the database — it just calls
// the service and returns what it gets back; Nest serializes the return value to
// JSON automatically. Every route here sits behind the global JwtAuthGuard like
// every other write endpoint in the app (§1 "No new permission model") — no
// @Public() on this controller. @Roles(UserRole.Owner) on the writes below is
// per-route, not per-controller, so GET stays open to any authenticated user — see
// products.controller.ts for the same reasoning (docs/phase-5-plan.md §2).
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll() {
    return this.categoriesService.findAll();
  }

  @Roles(UserRole.Owner)
  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Roles(UserRole.Owner)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(id, dto);
  }

  @Roles(UserRole.Owner)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT) // a successful DELETE returns no body — 204, not 200
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.categoriesService.remove(id);
  }
}
