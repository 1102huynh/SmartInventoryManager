import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 8 (docs/phase-8-plan.md §2): the two columns that back temporary account
// lockout. `failed_login_attempts` counts CONSECUTIVE failures — reset to 0 by any
// successful login and by an Owner's password reset (UsersService.clearLoginFailures),
// never decayed over time. `locked_until` is NULL (or a time in the past, which means
// the same thing) when the account is not locked — nothing has to sweep expired locks,
// "is it locked" is just `locked_until > now()` at read time.
//
// Single step each, same shape as AddAuditTimestampsToUsersAndCategories: `DEFAULT 0`
// is the backfill for the counter, and `locked_until` is nullable by design (there is
// nothing truthful to backfill it to). This is also what keeps every existing raw
// `INSERT INTO users (name, role, email, password_hash) ...` in the five e2e specs
// (app.e2e-spec.ts, auth.e2e-spec.ts, categories.e2e-spec.ts, roles.e2e-spec.ts,
// users.e2e-spec.ts) compiling and passing untouched — none of them name these
// columns, so none of them break on a NOT NULL violation.
//
// Plain TIMESTAMP for locked_until, matching the audit-timestamp convention
// (domain-model.md §8) even though this isn't an audit column (it's operational
// state, not a record of when something happened) — it is still server-set and never
// user-supplied, and starting a timestamptz island here is exactly the mid-schema
// second convention Phase 7 §7 already refused to start.
export class AddLoginLockoutToUsers1787560000000 implements MigrationInterface {
  name = 'AddLoginLockoutToUsers1787560000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMP NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "locked_until"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "failed_login_attempts"`,
    );
  }
}
