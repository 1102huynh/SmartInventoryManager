import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { UserRole } from '../common/enums/user-role.enum';
import { User } from '../users/user.entity';

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
  ) {}

  // Looks the user up by email and compares the supplied password against the stored
  // bcrypt hash — never the other way around (bcrypt is one-way by design; see
  // docs/learning-notes/authentication-and-guards.md "Hashing vs. encryption"). Returns
  // `null` on either an unknown email or a wrong password, deliberately the same
  // outcome for both — the controller turns that into one generic 401, so a caller
  // can't use this endpoint to enumerate which registered emails exist.
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) return null;
    const matches = await bcrypt.compare(password, user.passwordHash);
    return matches ? user : null;
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
