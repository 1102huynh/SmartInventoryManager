$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$root\pgsql\bin\pg_ctl.exe" -D "$root\pgdata" stop
