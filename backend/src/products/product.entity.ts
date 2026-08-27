import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Category } from '../categories/category.entity';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';

// Note what's deliberately *not* here: a `currentStock` column. domain-model.md is
// explicit that current stock is a derived projection of a product's transactions,
// not an owned field — storing it here would create two sources of truth that BR-042
// says can never diverge. InventoryService computes it on demand instead (see
// docs/learning-notes/database-transactions.md for how writes stay consistent with
// that without a stored column).
@Entity('products')
export class Product {
  @PrimaryGeneratedColumn()
  id: number;

  // BR-001: every product is uniquely identified by its SKU.
  @Index({ unique: true })
  @Column()
  sku: string;

  @Column()
  name: string;

  @Column()
  unit: string;

  @ManyToOne(() => Category, (category) => category.products, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'category_id' })
  category: Category | null;

  @Column({ name: 'category_id', type: 'int', nullable: true })
  categoryId: number | null;

  // BR-060/061: null means "no threshold configured" — never flagged low-stock,
  // not "flagged at zero". This has to be nullable, not defaulted to 0, to keep that
  // distinction representable.
  @Column({ name: 'low_stock_threshold', type: 'int', nullable: true })
  lowStockThreshold: number | null;

  @Column({ type: 'enum', enum: EntityStatus, default: EntityStatus.ACTIVE })
  status: EntityStatus;

  @OneToMany(() => InventoryTransaction, (tx) => tx.product)
  transactions: InventoryTransaction[];

  // Phase 10 (docs/phase-10-plan.md): timestamptz, not timestamp — every server-set
  // timestamp column in the schema now stores an instant, not a clock reading.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
