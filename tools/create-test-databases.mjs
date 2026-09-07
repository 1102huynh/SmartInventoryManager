// Creates the two test databases the backend suite needs — smart_inventory_test
// (integration) and smart_inventory_e2e (e2e) — idempotently.
//
// Why this exists: the portable PostgreSQL in tools/pgsql/ is a stripped build
// (see tools/README.md and the project's setup notes) — it ships initdb, pg_ctl,
// and postgres only, with no `createdb` or `psql`. So a database has to be created
// over a connection instead. This uses the `pg` client that already lives in
// backend/node_modules (resolved explicitly below, so cwd does not matter):
//
//     node tools/create-test-databases.mjs
//
// CI does not use this script — GitHub's Linux runners have the real `createdb`
// (see .github/workflows/ci.yml). This is a local-dev convenience only.
//
// Connection defaults match tools/README.md (127.0.0.1:55432, user postgres, trust
// auth, no password); override with DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD.

import { createRequire } from 'node:module';

// Resolve `pg` from the backend package, not from tools/ — this file lives outside
// any node_modules tree of its own.
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Client } = require('pg');

const TARGETS = ['smart_inventory_test', 'smart_inventory_e2e'];

const client = new Client({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 55432),
  user: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD || undefined,
  database: 'postgres', // connect to the always-present maintenance database
});

try {
  await client.connect();
  for (const name of TARGETS) {
    // CREATE DATABASE cannot be parameterised and cannot run inside a transaction;
    // the name here is a hard-coded literal, not user input.
    try {
      await client.query(`CREATE DATABASE ${name}`);
      console.log(`created ${name}`);
    } catch (err) {
      if (err.code === '42P04') console.log(`${name} already exists — skipped`);
      else throw err;
    }
  }
} finally {
  await client.end();
}

console.log(
  '\nsmart_inventory_test needs no migration (the integration specs build and drop\n' +
    'their own schema). For smart_inventory_e2e, run once now and after any new migration:\n' +
    '  DB_DATABASE=smart_inventory_e2e npm run migration:run   (from backend/)',
);
