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

// `currentStock` is a stored column as of Phase 23 (docs/phase-23-plan.md, issue #13)
// — a *materialisation* of `SUM(quantity_delta)` over the product's
// `inventory_transactions`, not an independently editable field. It exists so the
// Product List and dashboard reads stop aggregating the whole (unprunable) transaction
// history on every request. BR-042 still holds — "current stock always replays from
// history" — because `InventoryService.insertTransaction` *recomputes* this column
// from that history on every stock write, inside the pessimistic product-row lock the
// write already holds (BR-043). It is never patched incrementally and no read trusts
// it without that guarantee. See docs/learning-notes/database-transactions.md.
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

  // Phase 23: materialised current stock — SUM(quantity_delta) over this product's
  // inventory_transactions, kept equal to a fresh replay by the write-path invariant
  // (BR-042/BR-043). See the class comment above. Non-null; a product with no
  // transactions is at 0, not "unknown".
  @Column({ name: 'current_stock', type: 'int', default: 0 })
  currentStock: number;

  @OneToMany(() => InventoryTransaction, (tx) => tx.product)
  transactions: InventoryTransaction[];

  // Phase 10 (docs/phase-10-plan.md): timestamptz, not timestamp — every server-set
  // timestamp column in the schema now stores an instant, not a clock reading.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
