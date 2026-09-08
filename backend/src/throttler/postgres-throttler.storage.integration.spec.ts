import { DataSource } from 'typeorm';
import { createTestDataSource } from '../database/test-data-source';
import { PostgresThrottlerStorage } from './postgres-throttler.storage';
import { ThrottleHit } from './throttle-hit.entity';

// INTEGRATION, not unit: Phase 21 (docs/phase-21-plan.md §5). The whole store is one
// `INSERT ... ON CONFLICT DO UPDATE` — a mock cannot prove the window resets after
// `expires_at`, that the upsert is atomic under concurrency, or that the sweep
// deletes the right rows. Only a real database can. There is no unit spec for this
// class by design (plan §5).
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('PostgresThrottlerStorage (integration, Phase 21)', () => {
  let dataSource: DataSource;
  let storage: PostgresThrottlerStorage;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    storage = new PostgresThrottlerStorage(
      dataSource.getRepository(ThrottleHit),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE throttle_hits');
  });

  const KEY = 'test-key';

  it('the first hit against a key returns totalHits 1, not blocked, with a fresh window', async () => {
    const rec = await storage.increment(KEY, 60_000, 5);
    expect(rec.totalHits).toBe(1);
    expect(rec.isBlocked).toBe(false);
    expect(rec.timeToExpire).toBeGreaterThan(0);
    expect(rec.timeToExpire).toBeLessThanOrEqual(60);
  });

  it('counts up to the limit un-blocked, then blocks on limit + 1', async () => {
    const limit = 3;
    for (let n = 1; n <= limit; n++) {
      const rec = await storage.increment(KEY, 60_000, limit);
      expect(rec.totalHits).toBe(n);
      expect(rec.isBlocked).toBe(false);
    }
    const over = await storage.increment(KEY, 60_000, limit);
    expect(over.totalHits).toBe(limit + 1);
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('resets the window once expires_at has passed', async () => {
    const limit = 2;
    const ttl = 150;
    await storage.increment(KEY, ttl, limit);
    await storage.increment(KEY, ttl, limit);
    const blocked = await storage.increment(KEY, ttl, limit);
    expect(blocked.isBlocked).toBe(true);

    await new Promise((r) => setTimeout(r, ttl + 100));

    const afterExpiry = await storage.increment(KEY, ttl, limit);
    expect(afterExpiry.totalHits).toBe(1);
    expect(afterExpiry.isBlocked).toBe(false);
  });

  it('does not lose an update under concurrent increments on one key', async () => {
    const limit = 5;
    const concurrent = 10;
    const results = await Promise.all(
      Array.from({ length: concurrent }, () =>
        storage.increment(KEY, 60_000, limit),
      ),
    );

    // With row-level atomicity the returned totalHits are all distinct up to the
    // cap (limit + 1); a lost update would make two calls return the same count.
    const distinct = new Set(results.map((r) => r.totalHits));
    expect(distinct.size).toBe(Math.min(concurrent, limit + 1));

    const row = await dataSource
      .getRepository(ThrottleHit)
      .findOneByOrFail({ key: KEY });
    expect(row.hits).toBe(limit + 1);
  });

  it('sweeps rows whose window has expired and leaves live ones', async () => {
    const repo = dataSource.getRepository(ThrottleHit);
    await repo.query(
      `INSERT INTO throttle_hits (key, hits, expires_at) VALUES
         ('expired', 9, now() - interval '1 minute'),
         ('live', 1, now() + interval '1 minute')`,
    );

    // onApplicationBootstrap() runs the same sweep the opportunistic path does.
    await storage.onApplicationBootstrap();

    expect(await repo.findOneBy({ key: 'expired' })).toBeNull();
    expect(await repo.findOneBy({ key: 'live' })).not.toBeNull();
  });
});
