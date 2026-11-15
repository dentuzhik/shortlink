#!/bin/sh
set -eu
# Only inspect filesystem headroom; the source PVC is mounted read-only.
available_kib=$(df -Pk /source-data | awk 'NR==2 {print $4}')
printf '{"sourceFilesystemAvailableKiB":%s}\n' "$available_kib"
if [ "$available_kib" -lt 524288 ]; then
  printf '%s\n' 'Source filesystem has less than 512 MiB available.' >&2
  exit 3
fi
slot_required=$(cat /check/require-slot)
exec psql -X -qAt -v ON_ERROR_STOP=1 -v "slot_required=$slot_required" -f /check/check.sql
