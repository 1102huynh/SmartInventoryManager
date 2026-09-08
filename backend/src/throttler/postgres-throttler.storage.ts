import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
// Not re-exported from the package root; the storage-record shape lives here.
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThrottleHit } from './throttle-hit.entity';

// Fork C1 (docs/phase-21-plan.md §1): roughly one request in a thousand also runs the
// expired-row sweep. Small enough to be free on average, frequent enough that a
// distributed scan minting one row per address cannot outrun it.
const SWEEP_PROBABILITY = 0.001;

// Phase 21 (docs/phase-21-plan.md), issue #11. The shared, durable replacement for
// @nestjs/throttler's default in-memory `Map` store: the configured limits still mean
// what they say once the API runs as more than one instance, the same way Phase 8's
// account lockout already does (Postgres-backed). Selected via the `storage:` option
// in AppModule's ThrottlerModule.forRootAsync.
@Injectable()
export class PostgresThrottlerStorage
  implements ThrottlerStorage, OnApplicationBootstrap
{
  private readonly logger = new Logger(PostgresThrottlerStorage.name);

  constructor(
    @InjectRepository(ThrottleHit)
    private readonly hits: Repository<ThrottleHit>,
  ) {}

  // One atomic INSERT ... ON CONFLICT DO UPDATE. Postgres row-locks the conflicting
  // row, so two simultaneous requests for one key serialise and increment to 2, never
  // to 1-and-1 — this store does NOT carry Phase 8 registerFailedLogin's admitted
  // lost-update race, because the atomic upsert removes it for free.
  //
  // Fixed window, deliberately (plan §1): once `expires_at` passes, `hits` resets to 1
  // and the window restarts. Differs from the default store's per-hit sliding
  // decrement; matches what the throttler ecosystem's Redis store does; its boundary
  // burst (up to 2N across 2*ttl) is within tolerance for a 120/60s backstop and a
  // 10/300s login limit.
  //
  // The ThrottlerStorage interface also passes `blockDuration` and `throttlerName`;
  // this store needs neither, so they are omitted (a shorter parameter list still
  // satisfies the interface). `blockDuration` is treated as equal to `ttl`: nothing in
  // this app sets a distinct @Throttle blockDuration, so "blocked" is just "over the
  // limit while the window is still open". A `blocked_until` column is where a real
  // block period would go if a future phase configures one (plan §7).
  async increment(
    key: string,
    ttl: number,
    limit: number,
  ): Promise<ThrottlerStorageRecord> {
    const rows = await this.hits.query<
      Array<{ totalHits: number; timeToExpire: number }>
    >(
      `INSERT INTO throttle_hits AS t (key, hits, expires_at)
       VALUES ($1, 1, now() + $2 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN t.expires_at <= now() THEN 1
                     ELSE LEAST(t.hits + 1, $3 + 1) END,
         expires_at = CASE WHEN t.expires_at <= now()
                           THEN now() + $2 * interval '1 millisecond'
                           ELSE t.expires_at END
       RETURNING hits AS "totalHits",
                 GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::int
                   AS "timeToExpire"`,
      [key, ttl, limit],
    );

    const { totalHits, timeToExpire } = rows[0];
    const isBlocked = totalHits > limit;

    this.maybeSweep();

    return {
      totalHits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? timeToExpire : 0,
    };
  }

  // Fork C4: clear whatever expired rows piled up while this process was down.
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.warn(`throttle_hits startup sweep failed: ${messageOf(err)}`);
    }
  }

  // Fire-and-forget, errors swallowed — the best-effort shape BR-082's audit write
  // uses: a sweep that fails must never fail the request that triggered it.
  private maybeSweep(): void {
    if (Math.random() >= SWEEP_PROBABILITY) return;
    void this.sweep().catch((err: unknown) => {
      this.logger.warn(`throttle_hits sweep failed: ${messageOf(err)}`);
    });
  }

  private async sweep(): Promise<void> {
    await this.hits.query(
      `DELETE FROM throttle_hits WHERE expires_at <= now()`,
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
