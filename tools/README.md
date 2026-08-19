# Local PostgreSQL (portable, no install)

This folder holds a **portable PostgreSQL 17.6** distribution (the official EDB
Windows binaries zip — no installer, no Windows service, no admin rights required)
used for local backend development.

- `pgsql/` — the PostgreSQL binaries (`bin/`, `lib/`, `share/`, …).
- `pgdata/` — the actual database cluster (data files). Do not commit this to git.
- `pg.log` — server log output.

It listens on **127.0.0.1:55432** (a non-default port, chosen so it never collides
with a "real" Postgres install on 5432) with trust authentication for local
connections — fine for a throwaway dev database, not how you'd configure a real
deployment.

## Start / stop

```
pwsh tools/pg-start.ps1
pwsh tools/pg-stop.ps1
```

or directly:

```
tools/pgsql/bin/pg_ctl.exe -D tools/pgdata -l tools/pg.log -o "-p 55432 -h 127.0.0.1" start
tools/pgsql/bin/pg_ctl.exe -D tools/pgdata stop
```

## Connect

```
tools/pgsql/bin/psql.exe -p 55432 -U postgres -h 127.0.0.1 -d smart_inventory
```

The `smart_inventory` database was created once with `createdb`. The backend's
`.env` (see `backend/.env.example`) points at this same host/port/database.
