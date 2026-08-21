import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { hashPassword, verifyPassword } from '../common/password';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';

// Phase 6 (docs/phase-6-plan.md): this class stops being read-only. Users are a
// managed resource now — an Owner can create, edit, deactivate/reactivate, and reset
// the password of any account; every user can change their own. See UsersController
// for the (Owner-only, class-level @Roles) routes that call into this.
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.usersRepository.find({ order: { id: 'ASC' } });
  }

  async findOne(id: number): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    return user;
  }

  async create(dto: CreateUserDto): Promise<User> {
    const email = normalizeEmail(dto.email);
    await this.assertEmailAvailable(email);
    const passwordHash = await hashPassword(dto.password);
    const user = this.usersRepository.create({
      name: dto.name,
      email,
      role: dto.role,
      passwordHash,
    });
    return this.usersRepository.save(user);
  }

  // name / email / role only — never password (see SetUserPasswordDto /
  // ChangePasswordDto for the two password flows). BR-075's last-Owner check lives
  // here, on the role branch, rather than only in a dedicated role endpoint — role is
  // just another editable attribute of the account (docs/phase-6-plan.md §1 "Role
  // changes ride on PATCH /users/:id, not a separate PATCH /users/:id/role").
  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    if (dto.email !== undefined) {
      const email = normalizeEmail(dto.email);
      if (email !== user.email) {
        await this.assertEmailAvailable(email);
        user.email = email;
      }
    }
    if (dto.name !== undefined) user.name = dto.name;
    if (dto.role !== undefined && dto.role !== user.role) {
      // BR-075: only DEMOTING an Owner away from the role can ever violate the
      // invariant — promoting Staff to Owner only ever adds an active Owner.
      if (user.role === UserRole.Owner && dto.role !== UserRole.Owner) {
        await this.assertOwnerRemains(id);
      }
      user.role = dto.role;
    }
    return this.usersRepository.save(user);
  }

  async setStatus(id: number, status: EntityStatus): Promise<User> {
    const user = await this.findOne(id);
    // BR-075: only DEACTIVATING a currently-active Owner can violate the invariant —
    // reactivating one, or deactivating a Staff member, never can.
    if (
      user.role === UserRole.Owner &&
      user.status === EntityStatus.ACTIVE &&
      status === EntityStatus.INACTIVE
    ) {
      await this.assertOwnerRemains(id);
    }
    user.status = status;
    return this.usersRepository.save(user);
  }

  // The Owner's reset (docs/phase-6-plan.md §1 "PATCH /users/:id/password is a
  // *reset*, not a *recovery*") — no current-password check, because the caller here
  // is an Owner acting on someone else's account, not the account holder.
  async setPassword(id: number, newPassword: string): Promise<void> {
    const user = await this.findOne(id);
    user.passwordHash = await hashPassword(newPassword);
    await this.usersRepository.save(user);
  }

  // A valid token proves who opened the tab, not who is sitting at it now — so even
  // an already-authenticated caller has to prove they know the CURRENT password
  // before it's replaced. 401 (not 403, not 400): the failure is "you have not proven
  // you are this user," which is exactly what 401 means, the same category as a
  // failed login.
  async changeOwnPassword(
    id: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.findOne(id);
    const matches = await verifyPassword(currentPassword, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    user.passwordHash = await hashPassword(newPassword);
    await this.usersRepository.save(user);
  }

  private async assertEmailAvailable(email: string): Promise<void> {
    const existing = await this.usersRepository.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException(`Email "${email}" is already in use.`);
    }
  }

  // BR-075: at least one active Owner must always exist. Counts Owners with
  // status='active' OTHER than `userId` — "active" is part of the rule (a
  // deactivated Owner can't log in, so counting one would permit a state that
  // satisfies the letter of the invariant while locking everyone out in practice),
  // and excluding `userId` itself is what lets an Owner demote or deactivate
  // themselves as long as another active Owner remains, rather than blocking any
  // self-modification outright.
  //
  // Read-then-write, not transaction-wrapped: the theoretical race (two Owners
  // demoting/deactivating each other at the same instant) is not worth a row lock at
  // the scale this product targets — a single small business with at most a handful
  // of Owners. See docs/phase-6-plan.md §5.
  private async assertOwnerRemains(userId: number): Promise<void> {
    const remaining = await this.usersRepository.count({
      where: {
        role: UserRole.Owner,
        status: EntityStatus.ACTIVE,
        id: Not(userId),
      },
    });
    if (remaining === 0) {
      throw new ConflictException(
        'At least one active Owner must remain — this change would leave none.',
      );
    }
  }
}

// `UQ_users_email` and Postgres `=` are both case-sensitive, so without this,
// "alex@example.com" and "Alex@example.com" would pass as two distinct, both-valid
// accounts — the 409 the DTOs and docs promise on a duplicate email wouldn't actually
// fire, and only the exact case used at signup could ever log in. Normalizing at the
// one place email reaches storage (create/update, above) keeps every stored email
// lowercase, which is what makes the uniqueness check (and login lookup, which was
// already exact-match) actually mean what it says.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
