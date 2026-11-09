#!/bin/sh
set -eu

test -f .env || cp .env.example .env
exec docker compose --parallel 1 up --build -d --wait
