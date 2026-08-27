import { Exclude } from 'class-transformer';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';

// Phase 2 kept this table deliberately minimal — see docs/backend-use-cases.md
// "Deferred: Authentication" — just enough for every InventoryTransaction to point at
// *someone* (FR-061). Phase 3 (docs/phase-3-plan.md) adds real credentials: email is
// the login identifier (unique, matching the pattern already used by
// Supplier.email), and passwordHash is a bcrypt hash — the plaintext password is
// never stored anywhere, including here.
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ unique: true })
  email: string;

  // Phase 6 (docs/phase-6-plan.md §1 "Users are deactivated, never deleted"): reuses
  // EntityStatus, the same Active/Inactive lifecycle Product.status and
  // Supplier.status already share — see AuthService.validateUser and
  // JwtStrategy.validate for the two places an inactive user is actually stopped.
  @Column({ type: 'enum', enum: EntityStatus, default: EntityStatus.ACTIVE })
  status: EntityStatus;

  // @Exclude marks this field to be stripped by ClassSerializerInterceptor (registered
  // globally in main.ts) before a response is serialized to JSON — the one thing that
  // must never leave the server, even accidentally via a joined read (e.g. a
  // transaction's `recordedBy`). See docs/learning-notes/authentication-and-guards.md
  // "Hashing vs. encryption" for why this holds a bcrypt hash, never the plaintext.
  @Exclude()
  @Column({ name: 'password_hash' })
  passwordHash: string;

  // Phase 7 (docs/phase-7-plan.md): the audit-timestamp pair Product/Supplier already
  // carry. Not excluded — unlike passwordHash, these carry no secret and no access-
  // control weight, so they're safe to serialize even on the nested `recordedBy` a
  // transaction read embeds.
  // Phase 10 (docs/phase-10-plan.md): timestamptz, not timestamp — every server-set
  // timestamp column in the schema now stores an instant, not a clock reading.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // Phase 8 (docs/phase-8-plan.md §2): the login-lockout counter pair. Both @Exclude()d
  // — unlike the audit timestamps above, these are operational security state, and a
  // GET /products response should not tell every authenticated user which colleague is
  // currently locked out (or close to it) via the nested `recordedBy`. The one
  // Owner-visible presentation (UsersController's `locked` boolean on GET /users) reads
  // them through an explicit computed shape rather than by un-excluding these columns.
  @Exclude()
  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
  failedLoginAttempts: number;

  // NULL, or a time in the past, both mean "not locked" — nothing sweeps expired locks;
  // UsersService.isLocked is the one place that interprets this column.
  //
  // Phase 10 (docs/phase-10-plan.md §1): timestamptz even though Phase 8 was explicit
  // that this is not an audit column ("operational state, not a record of when
  // something happened"). It converts anyway because `isLocked` is a comparison of
  // two *instants* (`user.lockedUntil.getTime() > Date.now()`), read back and compared
  // against the current time on every authenticated login.
  //
  // Unlike created_at/updated_at (@CreateDateColumn/@UpdateDateColumn, which TypeORM
  // fills in via the SQL literal DEFAULT/CURRENT_TIMESTAMP whenever the entity carries
  // no value — the only way this app ever uses them, and why they land in Postgres's
  // session zone, same as a raw DEFAULT now()), this value has no database default to
  // defer to: `registerFailedLogin` computes it itself, so it goes to `pg` as an actual
  // Date parameter and keeps NODE's own zone, offset discarded, on the way into a naive
  // column. Its write zone and read zone were therefore both Node's already, so the
  // everyday "Postgres session zone vs Node zone" mismatch every audit column faced
  // never applied here — confirmed by reverting this column alone to `timestamp` under
  // a pinned-Postgres-session-zone harness and finding the round trip still correct,
  // where the audit-column equivalent fails reliably (docs/phase-10-plan.md §5). What
  // this column IS exposed to is narrower: Node's own zone changing between the write
  // and a later read — a restart onto a differently-zoned host, or a DST transition (a
  // lock set at 01:30 local on a fall-back night reading back an hour off). It converts
  // anyway because whatever the convention is, this column follows it, rather than
  // becoming a second `timestamp` island now that every other server-set column here is
  // `timestamptz`.
  @Exclude()
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;
}
