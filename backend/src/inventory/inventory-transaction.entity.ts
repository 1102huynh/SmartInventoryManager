import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TransactionType } from '../common/enums/transaction-type.enum';
import { Product } from '../products/product.entity';
import { Supplier } from '../suppliers/supplier.entity';
import { User } from '../users/user.entity';

// The single source of truth for stock movement (domain-model.md §4). BR-051 says
// these rows are immutable once created — notice there is no UpdateDateColumn and no
// UPDATE/DELETE endpoint anywhere for this entity; a correction is always a *new* row
// (a new Adjustment), never a change to an old one.
//
// The two @Check constraints below encode BR-050 directly in the schema, as a second
// line of defense behind the service-layer validation: even a bug or a future direct
// SQL script can't produce a row that violates these rules.
//
// Phase 11 (docs/phase-11-plan.md §1 "The index Phase 9 added and Phase 2 never did"):
// the class-level @Index below is the composite both bounded log reads order by
// (occurred_at DESC, id DESC — the id tie-break is load-bearing, because occurred_at
// comes from <input type="date"> and every row on one business day is byte-identical
// in it). It exists here as well as in
// 1787830000000-AddInventoryTransactionsOccurredAtIndex so smart_inventory_test
// (synchronize: true) builds it too — the same three-registries split Phases 9 and 10
// each had. The two are deliberately NOT byte-identical: TypeORM's class-level
// @Index([...]) takes column names only and cannot express per-column DESC, so the
// test database gets (occurred_at ASC, id ASC) where the migration creates DESC/DESC.
// Postgres scans a b-tree backwards at the same cost, so both satisfy the ORDER BY as
// an index scan and no query behaves differently — the difference is expected, not a bug.
@Entity('inventory_transactions')
@Index(['occurredAt', 'id'])
@Check(`"quantity_delta" <> 0`)
@Check(`type = 'stock_in' OR supplier_id IS NULL`) // supplier only makes sense on stock-in
@Check(`type <> 'adjustment' OR (reason IS NOT NULL AND reason <> '')`) // BR-032
export class InventoryTransaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @ManyToOne(() => Product, (product) => product.transactions, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ name: 'product_id' })
  productId: number;

  @Column({ type: 'enum', enum: TransactionType })
  type: TransactionType;

  // Signed: positive for stock-in and upward adjustments, negative for stock-out and
  // downward adjustments. Storing the signed delta (rather than an unsigned quantity
  // plus a type-based sign lookup) is what makes "current stock = SUM(quantity_delta)"
  // a one-line query instead of a CASE expression.
  @Column({ name: 'quantity_delta', type: 'int' })
  quantityDelta: number;

  // No longer the schema's one timestamptz exception (Phase 10,
  // docs/phase-10-plan.md) — it's the earliest example of the convention instead.
  // created_at below is timestamptz now too, so the business-fact/audit-fact
  // distinction between the two (domain-model.md §8) is carried entirely by the
  // column names and that section's prose, not by the types.
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'recorded_by_user_id' })
  recordedBy: User;

  @Column({ name: 'recorded_by_user_id' })
  recordedByUserId: number;

  // Only ever set when type = stock_in (enforced by the CHECK constraint above).
  @ManyToOne(() => Supplier, (supplier) => supplier.transactions, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'supplier_id' })
  supplier: Supplier | null;

  @Column({ name: 'supplier_id', type: 'int', nullable: true })
  supplierId: number | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  // Phase 10 (docs/phase-10-plan.md): timestamptz, not timestamp.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
