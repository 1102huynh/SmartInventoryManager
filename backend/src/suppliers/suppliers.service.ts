import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { QuerySuppliersDto } from './dto/query-suppliers.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { Supplier } from './supplier.entity';

@Injectable()
export class SuppliersService {
  constructor(
    @InjectRepository(Supplier)
    private readonly suppliersRepository: Repository<Supplier>,
  ) {}

  findAll(query: QuerySuppliersDto): Promise<Supplier[]> {
    return this.suppliersRepository.find({
      where: {
        ...(query.status ? { status: query.status } : {}),
        // ILike is TypeORM's case-insensitive LIKE — matches the mockup's
        // case-insensitive search behavior (Store.listSuppliers used .toLowerCase()).
        ...(query.search ? { name: ILike(`%${query.search}%`) } : {}),
      },
      order: { name: 'ASC' },
    });
  }

  async findOne(id: number): Promise<Supplier> {
    const supplier = await this.suppliersRepository.findOne({ where: { id } });
    // NotFoundException is a built-in HttpException subclass — throwing it anywhere
    // in a service is enough for Nest to turn it into a 404 JSON response; nothing
    // else has to catch it. See AllExceptionsFilter for what happens to errors that
    // AREN'T an HttpException.
    if (!supplier) throw new NotFoundException(`Supplier ${id} not found.`);
    return supplier;
  }

  create(dto: CreateSupplierDto): Promise<Supplier> {
    const supplier = this.suppliersRepository.create({
      name: dto.name,
      contactName: dto.contactName ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
    });
    return this.suppliersRepository.save(supplier);
  }

  async update(id: number, dto: UpdateSupplierDto): Promise<Supplier> {
    const supplier = await this.findOne(id);
    Object.assign(supplier, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.contactName !== undefined
        ? { contactName: dto.contactName }
        : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
    });
    return this.suppliersRepository.save(supplier);
  }

  async setStatus(id: number, status: Supplier['status']): Promise<Supplier> {
    const supplier = await this.findOne(id);
    supplier.status = status;
    return this.suppliersRepository.save(supplier);
  }
}
