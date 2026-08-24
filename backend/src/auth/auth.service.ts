import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityStatus } from '../common/enums/entity-status.enum';
import { UserRole } from '../common/enums/user-role.enum';
import { verifyPassword } from '../common/password';
import { User } from '../users/user.entity';
import { normalizeEmail, UsersService } from '../users/users.service';

export interface LoginResult {
  accessToken: string;
  user: { id: number; name: string; role: UserRole };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  // Looks the user up by email and compares the supplied password against the stored
  // bcrypt hash — never the other way around (bcrypt is one-way by design; see
  // docs/learning-notes/authentication-and-guards.md "Hashing vs. encryption"). Returns
  // `null` on either an unknown email or a wrong password, deliberately the same
  // outcome for both — the controller turns that into one generic 401, so a caller
  // can't use this endpoint to enumerate which registered emails exist.
  //
  // Phase 8 (docs/phase-8-plan.md §1): the lookup is normalized the same way
  // UsersService.create/update store it — a bug fixed while reading this function for
  // this phase, not introduced by it. Without this, "Alex@example.com" finds no row at
  // all (Postgres `=` is case-sensitive) even though the account exists as
  // "alex@example.com", and falls straight through the generic-401 branch below,
  // indistinguishable from a truly unknown email. Harmless for the lock (there's no
  // row to register a failure against), but a confusing dead end for a real user.
  //
  // Phase 6 (docs/phase-6-plan.md §1 "The login failure message for a deactivated
  // account is deliberately *not* generic"): the status check below runs strictly
  // AFTER verifyPassword has already succeeded — never before, never merged into the
  // "no such user" branch. Reaching the deactivated-account message therefore requires
  // already knowing the correct password, so it can't be used to probe which accounts
  // exist any more than the generic 401 can; checking status first, cheaply, before
  // the hash comparison would reopen exactly the enumeration hole Phase 3 closed. Do
  // not "simplify" this by moving the check earlier.
  //
  // Phase 8 extends the same ordering rule to a second state, the lock
  // (docs/phase-8-plan.md §1 "The lock message stays generic unless the password was
  // correct"): registerFailedLogin only ever runs after a WRONG password for a KNOWN
  // user, so an unknown email has nothing to count against and can never be locked —
  // and the lock's own message is only reachable by a caller who already typed the
  // correct password, for exactly the same enumeration-safety reason the deactivated
  // message is. The lock check sits AFTER the deactivated check because deactivation
  // is the more durable fact — an Owner switched this account off, and a fifteen-minute
  // countdown message on an administratively-closed account would be misleading.
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersRepository.findOne({
      where: { email: normalizeEmail(email) },
    });
    if (!user) return null;
    const matches = await verifyPassword(password, user.passwordHash);
    if (!matches) {
      await this.usersService.registerFailedLogin(user);
      return null;
    }
    if (user.status === EntityStatus.INACTIVE) {
      throw new UnauthorizedException(
        'This account has been deactivated. Ask an Owner to reactivate it.',
      );
    }
    if (this.usersService.isLocked(user)) {
      const minutesRemaining = Math.ceil(
        (user.lockedUntil!.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Too many failed attempts. Try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
      );
    }
    await this.usersService.clearLoginFailures(user);
    return user;
  }

  // Issues a single access token (no refresh token — see docs/phase-3-plan.md "Token:
  // a single JWT access token, no refresh token"). The payload only ever carries the
  // user's id (`sub` is the JWT-standard claim name for "subject") — everything else
  // about the user is looked up fresh from the database when it's actually needed
  // (e.g. GET /auth/me), so the token itself never goes stale if a user's name/role
  // changes later.
  login(user: User): LoginResult {
    const accessToken = this.jwtService.sign({ sub: user.id });
    return {
      accessToken,
      user: { id: user.id, name: user.name, role: user.role },
    };
  }
}
