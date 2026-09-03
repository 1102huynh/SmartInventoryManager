import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AdjustmentRequestStatus } from '../common/enums/adjustment-request-status.enum';
import { InventoryTransaction } from '../inventory/inventory-transaction.entity';
import { Product } from '../products/product.entity';
import { User } from '../users/user.entity';

// Phase 12 (docs/phase-12-plan.md §1 "Fork A — where a pending adjustment lives").
// A Staff-initiated adjustment is a *proposal about the future*, not a record of the
// past, so it lives in its own table with its own lifecycle rather than as a `status`
// column on inventory_transactions — which would break BR-051 (an
// inventory_transactions row would change after creation), put things that did not
// happen into the record of what happened, and add a `WHERE status = 'approved'`
// predicate to every existing stock read. Approving a request inserts an
// inventory_transactions row the ordinary way; inventory_transactions gains no column,
// no constraint, and no index from this phase.
//
// This is the FOURTH mutable table (created_at + updated_at), alongside products,
// suppliers, categories and users — contrast the two immutable ones,
// inventory_transactions and audit_events, which deliberately have no @UpdateDateColumn.
//
// Phase 11's index caveat, verbatim: TypeORM's class-level @Index([...]) takes column
// names only and cannot express per-column DESC, so smart_inventory_test
// (synchronize: true) builds (created_at ASC, id ASC) where the migration creates
// DESC/DESC. Postgres scans a b-tree backwards at the same cost, so both satisfy the
// ORDER BY as an index scan — the difference is expected, not a bug. The `id`
// tie-break is NOT load-bearing here the way it is on inventory_transactions'
// occurred_at (created_at is a server-set instant, so ties are vanishingly rare) — it
// is included so that all four bounded reads in the API spell the rule the same way.
//
// CHK_adjustment_requests_resolution encodes the state machine in the schema, in the
// same spirit as inventory_transactions' three @Check constraints: a bug or a direct
// SQL script cannot produce an approved request with no approver, or a rejection with
// no reason.
//
// Only two indexes, and both are in the migration too (so all three registries agree):
// the created_at/id composite the bounded read orders by, and the status index for the
// pending queue an Owner opens. product_id is deliberately NOT indexed — the plan's
// index discipline (docs/phase-12-plan.md §2, Phase 11 §7's "indexing anything else"
// caution): `?productId=` on this table and remove()'s pending-request count are both
// rare and the table stays small; if either ever bites, that is a deliberate migration
// with a measured reason, not a decorator added on spec.
@Entity('adjustment_requests')
@Index(['createdAt', 'id'])
@Index(['status'])
@Check(`"new_quantity" >= 0`)
@Check(`"reason" <> ''`)
@Check(`
  ("status" = 'pending'  AND "resolved_by_user_id" IS NULL
                         AND "resulting_transaction_id" IS NULL)
  OR ("status" = 'approved' AND "resolved_by_user_id" IS NOT NULL
                            AND "resulting_transaction_id" IS NOT NULL)
  OR ("status" IN ('rejected','withdrawn')
        AND "resolved_by_user_id" IS NOT NULL
        AND "resulting_transaction_id" IS NULL
        AND "resolution_reason" IS NOT NULL AND "resolution_reason" <> '')
`)
export class AdjustmentRequest {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Product, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ name: 'product_id' })
  productId: number;

  // The new *counted total*, not a delta — the same choice CreateAdjustmentDto makes
  // (Q-UI-2). It is load-bearing here: a stored delta would go stale if stock moves
  // between request and approval, while "the count was 40" stays exactly what was
  // observed. quantity_delta is computed at approval, under the pessimistic row lock
  // recordAdjustment already takes.
  @Column({ name: 'new_quantity', type: 'int' })
  newQuantity: number;

  // Validated (not-future, BR-052) when the request is submitted; not re-checked at
  // approval — a past date does not become a future one.
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  // BR-032: mandatory on every adjustment, free text.
  @Column({ type: 'text' })
  reason: string;

  @Column({
    type: 'enum',
    enum: AdjustmentRequestStatus,
    default: AdjustmentRequestStatus.PENDING,
  })
  status: AdjustmentRequestStatus;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'requested_by_user_id' })
  requestedBy: User;

  @Column({ name: 'requested_by_user_id' })
  requestedByUserId: number;

  // Captured at submission and never updated. Not used to compute anything — the delta
  // is computed at approval against current stock under lock — it exists so the
  // approver can see what the requester saw ("you counted 40 when the system said 35").
  @Column({ name: 'stock_at_request', type: 'int' })
  stockAtRequest: number;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'resolved_by_user_id' })
  resolvedBy: User | null;

  @Column({ name: 'resolved_by_user_id', type: 'int', nullable: true })
  resolvedByUserId: number | null;

  // Mandatory on reject and withdraw (mirrors BR-032's mandatory adjustment reason —
  // a rejection with no reason tells the requester nothing), optional on approve.
  @Column({ name: 'resolution_reason', type: 'text', nullable: true })
  resolutionReason: string | null;

  // Set once, at approval. A real FK with RESTRICT is safe because
  // inventory_transactions rows are never deleted (BR-051) — contrast
  // audit_events.entity_id, which is deliberately NOT a foreign key for the opposite
  // reason. The link lives on the request, not on the transaction: the History screen
  // does not show approval provenance and does not pretend to (§1, deferred in §7).
  @ManyToOne(() => InventoryTransaction, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'resulting_transaction_id' })
  resultingTransaction: InventoryTransaction | null;

  @Column({ name: 'resulting_transaction_id', type: 'int', nullable: true })
  resultingTransactionId: number | null;

  // Phase 10 convention: timestamptz. Mutable row, so it has an @UpdateDateColumn —
  // unlike inventory_transactions and audit_events.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
