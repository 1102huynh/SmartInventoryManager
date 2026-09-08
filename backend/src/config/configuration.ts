// A single, typed place that reads process.env. Everything else in the app imports
// AppConfig instead of touching process.env directly — one typo here breaks loudly
// at startup instead of silently as `undefined` deep inside some service.
export interface AppConfig {
  port: number;
  // Phase 21 (docs/phase-21-plan.md §1 Fork E): what to pass to Express's
  // `app.set('trust proxy', …)` (see main.ts). `false` — the default — means the app
  // talks to clients directly and `req.ip` is honest, which is correct for local dev.
  // Behind a load balancer it MUST be set (a hop count, `'loopback'`, or a CIDR list),
  // or every request looks like it comes from the balancer and the now-shared throttle
  // treats the whole world as one client. Was a "deployment note, not a code change"
  // in Phase 8; the shared throttle store makes it load-bearing.
  trustProxy: boolean | number | string;
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
  };
  // Phase 8 (docs/phase-8-plan.md §2): typed, not constants, for the same reason
  // jwtExpiresIn is — a policy number a deployment might reasonably change — and
  // because the e2e suite needs to raise the throttle limits and shrink the lockout
  // window to make both features actually testable (see auth.e2e-spec.ts).
  security: {
    maxFailedLoginAttempts: number;
    lockoutMinutes: number;
    throttleTtlSeconds: number;
    throttleLimit: number;
    loginThrottleTtlSeconds: number;
    loginThrottleLimit: number;
  };
}

// Express accepts `trust proxy` as a boolean, a hop count, or a string
// ('loopback', a comma-separated CIDR/IP list). Map TRUST_PROXY accordingly:
// unset/'' -> false, 'true'/'false' -> boolean, all-digits -> number, else the
// string verbatim.
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

// Passed to ConfigModule.forRoot({ load: [configuration] }) — Nest calls this once at
// startup and merges the result into ConfigService, on top of the parsed .env file.
export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  database: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'smart_inventory',
  },
  auth: {
    // The fallback is only ever hit in local dev (a missing .env) — never rely on it
    // outside that, which is exactly why .env.example ships its own random-looking
    // dev value instead of leaving this unset.
    jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
    // Phase 3 design decision: one access token, no refresh token, expiring after a
    // full shift — see docs/phase-3-plan.md "Token: a single JWT access token".
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },
  security: {
    // Five consecutive failures locks the account for fifteen minutes
    // (docs/phase-8-plan.md §1 "The lock is temporary and self-clearing").
    maxFailedLoginAttempts: parseInt(
      process.env.AUTH_MAX_FAILED_ATTEMPTS ?? '5',
      10,
    ),
    // parseFloat, not parseInt: the e2e suite needs a lockout window measured in
    // seconds (e.g. AUTH_LOCKOUT_MINUTES=0.05, three seconds) to prove auto-expiry
    // without a real fifteen-minute wait — parseInt would truncate that to 0 and
    // defeat the test (docs/phase-8-plan.md §5 "the lockout window shorten to a
    // second or two, which is also what makes the auto-expiry actually testable").
    lockoutMinutes: parseFloat(process.env.AUTH_LOCKOUT_MINUTES ?? '15'),
    // A generous backstop on every route.
    throttleTtlSeconds: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10),
    throttleLimit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
    // The tighter limit applied to POST /auth/login and PATCH /auth/password only
    // (see AuthController's @Throttle() overrides).
    loginThrottleTtlSeconds: parseInt(
      process.env.THROTTLE_LOGIN_TTL_SECONDS ?? '300',
      10,
    ),
    loginThrottleLimit: parseInt(process.env.THROTTLE_LOGIN_LIMIT ?? '10', 10),
  },
});
