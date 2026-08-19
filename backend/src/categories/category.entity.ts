import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Product } from '../products/product.entity';

// @Entity marks this class as a table definition — TypeORM reads the decorators on
// this class to generate/verify the `categories` table. It's plain reference data
// (domain-model.md: "no behavior of its own beyond classification"), so this is the
// simplest possible entity: no status, no relations to manage beyond being pointed at.
@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: string;

  @OneToMany(() => Product, (product) => product.category)
  products: Product[];
}
