import { Exclude } from 'class-transformer';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
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

  // @Exclude marks this field to be stripped by ClassSerializerInterceptor (registered
  // globally in main.ts) before a response is serialized to JSON — the one thing that
  // must never leave the server, even accidentally via a joined read (e.g. a
  // transaction's `recordedBy`). See docs/learning-notes/authentication-and-guards.md
  // "Hashing vs. encryption" for why this holds a bcrypt hash, never the plaintext.
  @Exclude()
  @Column({ name: 'password_hash' })
  passwordHash: string;
}
