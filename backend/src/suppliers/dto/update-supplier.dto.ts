import { PartialType } from '@nestjs/mapped-types';
import { CreateSupplierDto } from './create-supplier.dto';

// PartialType(CreateSupplierDto) generates a class with the same properties as
// CreateSupplierDto but all marked optional — reused here so "edit" validation can't
// drift out of sync with "create" validation as the entity grows fields over time.
// FR-011's edit form actually submits every field every time, so in practice this
// behaves the same as CreateSupplierDto; PartialType is what we'd lean on the moment
// a future "PATCH just one field" use case shows up.
export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}
