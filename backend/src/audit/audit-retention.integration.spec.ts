import { DataSource } from 'typeorm';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { createTestDataSource } from '../database/test-data-source';
import { AuditEvent } from './audit-event.entity';
import { AuditService } from './audit.service';

// INTEGRATION, not unit: Phase 22 (docs/phase-22-plan.md §5). The retention prune is
// one `DELETE FROM audit_events WHERE created_at < now() - interval` — which rows a
// one-year cutoff actually removes, and that a backdated `created_at` survives
// TypeORM's @CreateDateColumn, are things only a real database can show. The unit spec
// (audit.service.spec.ts) already pins the wiring: the probability gate, the swallowed
// error, the unconditional startup prune.
//
// Requires the local Postgres from tools/ to be running (see tools/README.md).
describe('AuditService retention prune (integration, Phase 22)', () => {
  let dataSource: DataSource;
  let service: AuditService;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    service = new AuditService(dataSource.getRepository(AuditEvent));
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE audit_events RESTART IDENTITY CASCADE',
    );
  });

  // @CreateDateColumn ignores a value assigned through the repository on insert, so a
  // row with a chosen `created_at` has to go in through raw SQL.
  async function insertAgedRow(daysAgo: number): Promise<number> {
    const rows = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO audit_events (event_type, summary, created_at)
       VALUES ($1, $2, now() - ($3::int * interval '1 day'))
       RETURNING id`,
      [AuditEventType.LOGIN_FAILED, `${daysAgo} days old`, daysAgo],
    );
    return Number(rows[0].id);
  }

  async function survivingIds(): Promise<number[]> {
    const rows = await dataSource.query<Array<{ id: number }>>(
      'SELECT id FROM audit_events ORDER BY id',
    );
    return rows.map((r) => Number(r.id));
  }

  it('deletes rows past the one-year window and keeps everything newer', async () => {
    const wayOld = await insertAgedRow(400);
    const justOver = await insertAgedRow(366);
    const justUnder = await insertAgedRow(364);
    const fresh = await insertAgedRow(1);

    // onApplicationBootstrap() runs the same prune the opportunistic path does, once.
    await service.onApplicationBootstrap();

    expect(await survivingIds()).toEqual(
      [justUnder, fresh].sort((a, b) => a - b),
    );
    // The boundary belongs to the newer side: a row exactly 365 days back is kept,
    // one a day past that is gone.
    expect(wayOld).toBeGreaterThan(0);
    expect(justOver).toBeGreaterThan(0);
  });

  it('record() opportunistically prunes stale rows once the probability roll passes', async () => {
    await insertAgedRow(400);
    await insertAgedRow(500);

    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await service.record({
        eventType: AuditEventType.LOGIN_SUCCEEDED,
        subjectUserId: null,
        summary: 'a fresh event',
      });
      // maybePrune() is fire-and-forget — give its DELETE a tick to land.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      jest.spyOn(Math, 'random').mockRestore();
    }

    const rows = await dataSource.query<Array<{ summary: string }>>(
      'SELECT summary FROM audit_events',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('a fresh event');
  });

  it('leaves the table alone when nothing is old enough', async () => {
    const a = await insertAgedRow(10);
    const b = await insertAgedRow(200);
    const c = await insertAgedRow(364);

    await service.onApplicationBootstrap();

    expect(await survivingIds()).toEqual([a, b, c].sort((x, y) => x - y));
  });
});
