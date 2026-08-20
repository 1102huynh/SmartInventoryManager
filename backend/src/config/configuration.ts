// A single, typed place that reads process.env. Everything else in the app imports
// AppConfig instead of touching process.env directly — one typo here breaks loudly
// at startup instead of silently as `undefined` deep inside some service.
export interface AppConfig {
  port: number;
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
}

// Passed to ConfigModule.forRoot({ load: [configuration] }) — Nest calls this once at
// startup and merges the result into ConfigService, on top of the parsed .env file.
export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
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
});
