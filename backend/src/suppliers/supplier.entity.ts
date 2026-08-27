import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';

@Entity('suppliers')
export class Supplier {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  // TypeORM can't infer a column type from a `string | null` TS union (reflect-metadata
  // reports it as bare "Object"), so nullable text/number columns need `type:` spelled
  // out explicitly — this bit everyone the first time they add a nullable field.
  @Column({ name: 'contact_name', type: 'varchar', nullable: true })
  contactName: string | null;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  // BR-002-equivalent for suppliers (FR-013): inactive suppliers are excluded from
  // the Stock-In supplier picker but keep appearing on historical transactions.
  @Column({ type: 'enum', enum: EntityStatus, default: EntityStatus.ACTIVE })
  status: EntityStatus;

  @OneToMany(() => InventoryTransaction, (tx) => tx.supplier)
  transactions: InventoryTransaction[];

  // Phase 10 (docs/phase-10-plan.md): timestamptz, not timestamp — every server-set
  // timestamp column in the schema now stores an instant, not a clock reading.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
