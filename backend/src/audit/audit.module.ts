import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEvent } from './audit-event.entity';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

// Phase 9 (docs/phase-9-plan.md §1 "The write is an explicit service call"). Does NOT
// import UsersModule — AuditService.record() takes actor/subject as plain ids, never
// User entities, specifically to avoid a UsersModule -> AuditModule -> UsersModule
// cycle. AuthModule, UsersModule, ProductsModule, SuppliersModule, and
// CategoriesModule each import this module to call record().
@Module({
  imports: [TypeOrmModule.forFeature([AuditEvent])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
