import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

// Phase 21 (docs/phase-21-plan.md §1). One row per throttle bucket — the key is the
// guard's own fully-qualified, sha256-hashed string (controller + handler + throttler
// name + client tracker), so this table knows nothing about IPs or routes; it counts
// hits against an opaque string.
//
// NOT a domain entity: it models nothing in product.md and appears in no
// domain-model.md relationship. It exists because @nestjs/throttler needs somewhere
// shared to keep its count once the app runs as more than one process (Phase 8 §7,
// issue #11).
//
// No created_at / updated_at, deliberately — domain-model.md §8's convention governs
// *audit* columns ("when was this row written / last changed"), and a disposable
// throttle counter that the next request overwrites has no audit question to answer.
// Same call as the missing @UpdateDateColumn on the immutable tables, for the
// opposite reason: there, nothing changes; here, nothing is worth recording.
//
// expires_at is server-set operational state, never user-supplied, so it is
// timestamptz — the users.locked_until precedent (Phase 8 §1, converted in Phase 10),
// not a plain-timestamp island.
//
// The migration creates this as an UNLOGGED table (docs/phase-21-plan.md §1 Fork B);
// TypeORM cannot express UNLOGGED, so the integration test database (test-data-source.ts,
// synchronize: true) builds it LOGGED. That difference is behaviourally invisible
// (durability and replication only) and is the same shape of documented, expected
// divergence as the @Check constraint names in Phase 18.
@Entity('throttle_hits')
export class ThrottleHit {
  // text, not varchar(n): a custom @Throttle key generator could produce any string.
  // The default guard key is 64 hex chars (sha256).
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'int' })
  hits: number;

  // Indexed for the opportunistic sweep's `WHERE expires_at <= now()`
  // (docs/phase-21-plan.md §1 Fork D). The migration names this index
  // IDX_throttle_hits_expires_at; synchronize generates its own name in the test
  // database — the same registries difference the class comment describes.
  @Index()
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
