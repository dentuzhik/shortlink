#!/bin/sh
set -eu

: "${PGDATA:?A fresh disposable data directory is required}"
/usr/lib/postgresql/18/bin/initdb -D "$PGDATA" \
  --username=restore_admin --encoding=UTF8 --locale-provider=libc \
  --lc-collate=en_US.utf8 --lc-ctype=en_US.utf8 \
  --auth-local=trust --auth-host=scram-sha-256

# Docker forwards the Mac's loopback connection through its bridge gateway.
# Permit only the fresh application role/database, with password authentication.
printf '%s\n' 'host restore_test shortlink_lab 0.0.0.0/0 scram-sha-256' >> "$PGDATA/pg_hba.conf"

exec /usr/lib/postgresql/18/bin/postgres -D "$PGDATA" \
  -c listen_addresses='*' -c unix_socket_directories=/tmp \
  -c shared_buffers=16MB -c max_connections=20 -c max_wal_size=128MB
