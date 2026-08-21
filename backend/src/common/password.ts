import * as bcrypt from 'bcrypt';

// Phase 6 (docs/phase-6-plan.md §1 "Password hashing moves to one place"): before this,
// bcrypt appeared in AuthService.validateUser (compare) and run-seed.ts (hash), each
// with its own cost factor that had to be kept in sync by hand. This phase adds two
// more call sites (UsersService.create/setPassword and the currentPassword check in
// changeOwnPassword), which is the point at which "just call bcrypt directly" stops
// being fine — one shared cost factor, defined once, used everywhere.
//
// Deliberately lives in src/common rather than on UsersService itself and is called
// FROM UsersService, not the other way around: AuthModule imports UsersModule, so
// AuthService depending on UsersService would be a module cycle. A plain function
// sidesteps that — neither service needs to know about the other.
export const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
