#!/usr/bin/env bash
# Baut die lokale Testdatenbank "kantine_test" neu auf:
# Supabase-Shim -> alle Migrationen (in Reihenfolge) -> Seed
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL_SU="su postgres -c"
$PSQL_SU "psql -v ON_ERROR_STOP=1 -qc \"do \\\$\\\$ begin if not exists (select 1 from pg_roles where rolname='kt') then create role kt superuser login password 'kt'; end if; end \\\$\\\$;\""
$PSQL_SU "psql -qc 'drop database if exists kantine_test'"
$PSQL_SU "psql -qc 'create database kantine_test owner kt'"
export PGPASSWORD=kt
P="psql -h localhost -U kt -d kantine_test -v ON_ERROR_STOP=1 -q"
$P -f tests/00_supabase_shim.sql
for f in migrations/*.sql; do echo "== $f"; $P -f "$f"; done
echo "== seed.sql"; $P -f seed.sql >/dev/null
echo "Datenbank bereit."
