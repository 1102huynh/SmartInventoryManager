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
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
