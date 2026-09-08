import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostgresThrottlerStorage } from './postgres-throttler.storage';
import { ThrottleHit } from './throttle-hit.entity';

// Phase 21 (docs/phase-21-plan.md §2). Provides the Postgres-backed ThrottlerStorage
// as an ordinary injectable so AppModule's ThrottlerModule.forRootAsync can pull it in
// as its `storage:` option (imports: [ThrottlerStorageModule], inject: [..., PostgresThrottlerStorage]).
//
// forFeature([ThrottleHit]) resolves against the root connection DatabaseModule
// registers — Nest builds the whole provider graph, so import order in AppModule does
// not matter here. No controller: nothing reads or writes throttle state over HTTP.
@Module({
  imports: [TypeOrmModule.forFeature([ThrottleHit])],
  providers: [PostgresThrottlerStorage],
  exports: [PostgresThrottlerStorage],
})
export class ThrottlerStorageModule {}
