import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';

// Read-only on purpose — there's no "create a user" use case in this phase (no
// login/signup exists yet, see docs/backend-use-cases.md). This just powers the
// frontend's "Signed in as ..." picker over the seeded demo users.
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findAll(): Promise<User[]> {
    return this.usersRepository.find({ order: { id: 'ASC' } });
  }
}
