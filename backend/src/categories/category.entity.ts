import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Product } from '../products/product.entity';

// @Entity marks this class as a table definition — TypeORM reads the decorators on
// this class to generate/verify the `categories` table. It's plain reference data
// (domain-model.md: "no behavior of its own beyond classification"), so this is the
// simplest entity that still follows the audit-timestamp convention (see
// domain-model.md "Audit timestamps"): no status, no relations to manage beyond
// being pointed at — but it IS renamed via PATCH (Phase 4), so it still earns
// updated_at the same way Product/Supplier/User do.
@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: string;

  @OneToMany(() => Product, (product) => product.category)
  products: Product[];

  // Phase 10 (docs/phase-10-plan.md): timestamptz, not timestamp — every server-set
  // timestamp column in the schema now stores an instant, not a clock reading.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
