import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { User } from '../users/user.entity';

// Phase 9 (docs/phase-9-plan.md §1). Modeled directly on InventoryTransaction, the
// app's other append-only entity — same @CreateDateColumn, same absence of an
// @UpdateDateColumn, same style of comment saying *why* the absence is deliberate.
// Nothing in this application UPDATEs or DELETEs a row here; there is no route and no
// service method that could (domain-model.md §8's immutable-table rule, second
// instance after inventory_transactions).
@Entity('audit_events')
@Index(['createdAt'])
@Index(['subjectUserId'])
export class AuditEvent {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'event_type', type: 'enum', enum: AuditEventType })
  eventType: AuditEventType;

  // The actor is not the subject — the sharpest line in the phase (§1). NULL for
  // every anonymous event: a failed login's actor is unknown BY DEFINITION, and
  // writing the matched user here would claim they typed their own wrong password.
  // RESTRICT is safe only because BR-076 guarantees a `users` row can never
  // disappear — contrast entityId below, which gets the opposite treatment for the
  // opposite reason.
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actor: User | null;

  @Column({ name: 'actor_user_id', type: 'int', nullable: true })
  actorUserId: number | null;

  // The account this event is ABOUT — never the same fact as actor, even when the
  // two values happen to coincide (a self-service password change).
  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'subject_user_id' })
  subject: User | null;

  @Column({ name: 'subject_user_id', type: 'int', nullable: true })
  subjectUserId: number | null;

  @Column({
    name: 'entity_type',
    type: 'enum',
    enum: AuditEntityType,
    nullable: true,
  })
  entityType: AuditEntityType | null;

  // Deliberately NOT a foreign key (§1): a product_deleted event points at an id that
  // no longer exists, which is the entire point of recording it. RESTRICT would
  // forbid the delete BR-004 permits; CASCADE would erase the record of the deletion
  // at the exact moment it happens — the one thing an audit log must never do.
  @Column({ name: 'entity_id', type: 'int', nullable: true })
  entityId: number | null;

  // A short human sentence, written by the service that records the event — never a
  // before/after diff, and never a credential (password, hash, or token), not even
  // "redacted". See AuditService.record.
  @Column({ type: 'text' })
  summary: string;

  // Scope fork A (§1): captured on authentication events only, NULL on every
  // administrative one. Sized for IPv6. Only as honest as `req.ip` is — see
  // client-ip.decorator.ts and the `trust proxy` note in .env.example/README.
  @Column({ name: 'actor_ip', type: 'varchar', length: 45, nullable: true })
  actorIp: string | null;

  // No @UpdateDateColumn, deliberately — see the class comment.
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
