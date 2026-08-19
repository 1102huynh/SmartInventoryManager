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
@Entity('inventory_transactions')
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
