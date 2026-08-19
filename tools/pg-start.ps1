$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$root\pgsql\bin\pg_ctl.exe" -D "$root\pgdata" -l "$root\pg.log" -o "-p 55432 -h 127.0.0.1" start
