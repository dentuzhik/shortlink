#!/bin/sh
set -eu
: "${PGDATA:?}"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  /usr/lib/postgresql/18/bin/initdb -D "$PGDATA" --username=fixture_admin \
    --encoding=UTF8 --locale-provider=libc --lc-collate=en_US.utf8 --lc-ctype=en_US.utf8 \
    --auth-local=trust --auth-host=scram-sha-256
  printf '%s\n' 'hostssl shortener shortlink_lab all scram-sha-256' >> "$PGDATA/pg_hba.conf"
fi
cp /tls/server.key "$PGDATA/server.key"
chmod 600 "$PGDATA/server.key"
exec /usr/lib/postgresql/18/bin/postgres -D "$PGDATA" \
  -c listen_addresses='*' -c unix_socket_directories=/tmp \
  -c shared_buffers=16MB -c max_connections=30 -c max_wal_size=128MB \
  -c ssl=on -c ssl_cert_file=/tls/ca.crt -c ssl_key_file="$PGDATA/server.key"
