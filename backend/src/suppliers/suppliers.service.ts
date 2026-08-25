import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../common/enums/audit-entity-type.enum';
import { AuditEventType } from '../common/enums/audit-event-type.enum';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { QuerySuppliersDto } from './dto/query-suppliers.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { Supplier } from './supplier.entity';

@Injectable()
export class SuppliersService {
  constructor(
    @InjectRepository(Supplier)
    private readonly suppliersRepository: Repository<Supplier>,
    private readonly auditService: AuditService,
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

  async create(dto: CreateSupplierDto, actorId: number): Promise<Supplier> {
    const supplier = this.suppliersRepository.create({
      name: dto.name,
      contactName: dto.contactName ?? null,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
    });
    const saved = await this.suppliersRepository.save(supplier);
    await this.auditService.record({
      eventType: AuditEventType.SUPPLIER_CREATED,
      actorUserId: actorId,
      entityType: AuditEntityType.SUPPLIER,
      entityId: saved.id,
      summary: `Created "${saved.name}"`,
    });
    return saved;
  }

  async update(
    id: number,
    dto: UpdateSupplierDto,
    actorId: number,
  ): Promise<Supplier> {
    const supplier = await this.findOne(id);
    const changes: string[] = [];
    if (dto.name !== undefined && dto.name !== supplier.name) {
      changes.push(`Name changed to ${dto.name}`);
    }
    if (dto.contactName !== undefined && dto.contactName !== supplier.contactName) {
      changes.push('Contact name changed');
    }
    if (dto.email !== undefined && dto.email !== supplier.email) {
      changes.push('Email changed');
    }
    if (dto.phone !== undefined && dto.phone !== supplier.phone) {
      changes.push('Phone changed');
    }
    Object.assign(supplier, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.contactName !== undefined
        ? { contactName: dto.contactName }
        : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
    });
    const saved = await this.suppliersRepository.save(supplier);
    if (changes.length > 0) {
      await this.auditService.record({
        eventType: AuditEventType.SUPPLIER_UPDATED,
        actorUserId: actorId,
        entityType: AuditEntityType.SUPPLIER,
        entityId: id,
        summary: changes.join('; '),
      });
    }
    return saved;
  }

  async setStatus(
    id: number,
    status: Supplier['status'],
    actorId: number,
  ): Promise<Supplier> {
    const supplier = await this.findOne(id);
    supplier.status = status;
    const saved = await this.suppliersRepository.save(supplier);
    await this.auditService.record({
      eventType: AuditEventType.SUPPLIER_STATUS_CHANGED,
      actorUserId: actorId,
      entityType: AuditEntityType.SUPPLIER,
      entityId: id,
      summary:
        status === EntityStatus.ACTIVE ? 'Reactivated' : 'Deactivated',
    });
    return saved;
  }
}
