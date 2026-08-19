import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Deliberately minimal — see docs/backend-use-cases.md "Deferred: Authentication".
// This table exists purely so every InventoryTransaction can point at *someone*
// (FR-061), without this phase taking on password/session/login work the UI doesn't
// support yet.
@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column()
  role: string;
}
