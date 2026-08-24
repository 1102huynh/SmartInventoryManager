import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AppConfig } from '../config/configuration';
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
    private readonly configService: ConfigService<AppConfig, true>,
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
  //
  // Phase 8 (docs/phase-8-plan.md §1 "An Owner's password reset clears the lock"):
  // this IS the unlock mechanism — clearing the two lock columns on the same save()
  // rather than adding a separate PATCH /users/:id/unlock route, because that route's
  // only ever user is an Owner who has already been told to just wait fifteen
  // minutes. changeOwnPassword below deliberately does NOT do this — see its comment.
  async setPassword(id: number, newPassword: string): Promise<void> {
    const user = await this.findOne(id);
    user.passwordHash = await hashPassword(newPassword);
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
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

  // Phase 8 (docs/phase-8-plan.md §1): true only while an unexpired lock is set. NULL,
  // or a time already in the past, both mean "not locked" — nothing has to sweep
  // expired locks, this is the one place that interprets the column. Also the read
  // path for UsersController's Owner-only `locked` boolean (§3) — a presentation of
  // this same fact, never the raw timestamp.
  isLocked(user: User): boolean {
    return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
  }

  // Called from AuthService.validateUser on every failed password check for a KNOWN
  // user (an unknown email has nothing to count against — see AuthService). Increments
  // the consecutive-failure counter and, on reaching the configured threshold, sets
  // lockedUntil — but ONLY if the account isn't already locked.
  //
  // That guard is load-bearing, not defensive: without it, a failed attempt against an
  // ALREADY-locked account would push lockedUntil further into the future every time,
  // and a script firing one guess a minute would keep the account locked forever —
  // converting a defensive feature into a permanent, attacker-triggered outage
  // (docs/phase-8-plan.md §1 "A lock must not become a denial-of-service weapon").
  // "Reset the timer on every failure" is the intuitive implementation and it is wrong.
  //
  // The guard above is not the whole story, though: `isLocked` is false for an
  // EXPIRED lock too (NULL and "in the past" mean the same thing), and a stale
  // `failedLoginAttempts` sitting at the threshold would otherwise re-lock the
  // account on the very next stray failure, over and over, at one request per
  // window instead of one per minute — the same permanent-outage failure mode
  // above, just slower and easier to miss. A lock that has actually expired is a
  // completed lock: the account earns a genuinely fresh count, not a live one
  // sitting one guess away from re-triggering.
  async registerFailedLogin(user: User): Promise<void> {
    if (this.isLocked(user)) return;
    if (user.lockedUntil) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
    }
    user.failedLoginAttempts += 1;
    const threshold = this.configService.get(
      'security.maxFailedLoginAttempts',
      {
        infer: true,
      },
    );
    if (user.failedLoginAttempts >= threshold) {
      const lockoutMinutes = this.configService.get('security.lockoutMinutes', {
        infer: true,
      });
      user.lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000);
    }
    await this.persistLoginState(user);
  }

  // Called from AuthService.validateUser on every successful login. A clean slate —
  // consecutive means consecutive, so any success (even the very next attempt after a
  // string of failures) resets the count, not just an Owner's reset (setPassword,
  // above).
  async clearLoginFailures(user: User): Promise<void> {
    if (user.failedLoginAttempts === 0 && user.lockedUntil === null) return;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.persistLoginState(user);
  }

  // Deliberately NOT `repository.save()` — the one place in this class that avoids
  // the pattern every other write method here uses. Phase 7 was explicit that
  // `updated_at` must mean "this row's own fields were edited," never "something
  // merely touched it." A failed login attempt is exactly that kind of touch — it
  // can be fired by a stranger who has never authenticated as anyone — so letting it
  // move `updated_at` would make the "Last updated" line an Owner reads on a
  // colleague's account silently mean "the last time someone guessed at this
  // password," not "the last time I edited this account." setPassword (above) keeps
  // `save()`, because an Owner's reset genuinely IS an edit to the row.
  //
  // Getting this right took a real correction: `repository.update()` does NOT skip
  // `@UpdateDateColumn` the way `docs/learning-notes/database-access.md` used to
  // claim — TypeORM's UpdateQueryBuilder auto-appends `SET "updated_at" =
  // CURRENT_TIMESTAMP` to ANY update whose target columns don't already include the
  // update-date column, `.update()` included; that "QueryBuilder skips the ORM
  // lifecycle" folklore turned out to be true for @BeforeUpdate()-style listeners,
  // not for this specific piece of column metadata. Proven wrong by an e2e test that
  // failed after switching to `.update()` and finding `updated_at` had moved anyway.
  // The actual fix, and the reason `updatedAt` appears in the object below: TypeORM
  // only auto-populates the update-date column when it is ABSENT from the values you
  // pass — explicitly including it (with its own current, unchanged value) is the
  // documented way to pin it, so this write pins the old value instead of letting
  // TypeORM invent a new one.
  private async persistLoginState(user: User): Promise<void> {
    await this.usersRepository.update(user.id, {
      failedLoginAttempts: user.failedLoginAttempts,
      lockedUntil: user.lockedUntil,
      updatedAt: user.updatedAt,
    });
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
// lowercase, which is what makes the uniqueness check mean what it says.
//
// Exported (Phase 8, docs/phase-8-plan.md §1 "the email-casing bug in the function
// this phase edits"): AuthService.validateUser's login lookup used to compare the raw
// input against this normalized-at-write value, so "Alex@example.com" could never log
// in even though "alex@example.com" was the real, stored account — a bug found while
// reading the code for this phase, not introduced by it, fixed here by giving the
// login lookup the same normalization instead of duplicating the logic.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
