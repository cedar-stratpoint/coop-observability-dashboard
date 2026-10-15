#!/usr/bin/env bash
# LOCAL ONLY. Starts `next dev` against the local Supabase harness and nothing else.
#  1. sources scripts/local-supabase/.local-env (never .env)
#  2. aborts unless SUPABASE_URL_ARCHIVE is a loopback URL
#  3. sets EVERY Supabase-looking variable name found in .env/.env.local to the local value, or to empty, in the process
#     environment (Next never overrides a variable that is already set), so a hosted project is unreachable by mistake
#  4. preloads block-remote.cjs, which throws on any *.supabase.co / .in / .net request as a second line of defence
# Extra arguments go to `next dev` (for example: scripts/local-supabase/dev.sh -p 3100).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENVF="$HERE/.local-env"
[ -f "$ENVF" ] || { echo "dev.sh: $ENVF not found: run scripts/local-supabase/up.sh first" >&2; exit 1; }

# Blank every Supabase-looking name that .env or .env.local declares. Names only: values are never read or printed.
for f in "$ROOT/.env" "$ROOT/.env.local"; do
  [ -f "$f" ] || continue
  for name in $(grep -oE '^(export )?[A-Za-z0-9_]*(SUPABASE|DATABASE_URL|POSTGRES|PGHOST)[A-Za-z0-9_]*=' "$f" | sed -E 's/^export //; s/=$//'); do
    export "$name="
  done
done
# The CRM proxy is a hosted service too: keep a local run off it (the chat's Website totals then say 'not connected'; the CRM pages render empty).
export CRM_API_URL= CRM_API_READ_TOKEN=

set -a; . "$ENVF"; set +a   # the local values win over the blanks above

case "$SUPABASE_URL_ARCHIVE" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "dev.sh: refusing: SUPABASE_URL_ARCHIVE is not a loopback URL" >&2; exit 1 ;;
esac
host="$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$SUPABASE_URL_ARCHIVE")"
case "$host" in 127.0.0.1|localhost) ;; *) echo "dev.sh: refusing: host is not loopback" >&2; exit 1 ;; esac

# Explore mode opens a real Postgres connection: it must be loopback too (same rule as resolveExploreAccess and assertLocalPostgres).
# Checked on the text after the FIRST '@' (that is where the driver reads the host from) so an @-trick or a host list cannot pass.
if [ -n "${EXPLORE_DATABASE_URL:-}" ]; then
  explore_auth="${EXPLORE_DATABASE_URL#*://}"; explore_auth="${explore_auth%%[/?#]*}"; explore_host="${explore_auth#*@}"
  case "${EXPLORE_DATABASE_URL%%://*}" in postgres|postgresql) ;; *) echo "dev.sh: refusing: EXPLORE_DATABASE_URL is not a postgres:// URL" >&2; exit 1 ;; esac
  case "$explore_host" in
    127.0.0.1|127.0.0.1:[0-9]*|localhost|localhost:[0-9]*) ;;
    *) echo "dev.sh: refusing: EXPLORE_DATABASE_URL host is not loopback" >&2; exit 1 ;;
  esac
  case "$explore_host" in *[!0-9a-z.:]*) echo "dev.sh: refusing: EXPLORE_DATABASE_URL host has unexpected characters" >&2; exit 1 ;; esac
fi

export DEV_AUTH_BYPASS=true
export COOP_REQUIRE_LOCAL_DB=1   # the reports clients also refuse any non-local URL
export NODE_OPTIONS="--require $HERE/block-remote.cjs ${NODE_OPTIONS:-}"
echo "dev.sh: local Supabase at $SUPABASE_URL_ARCHIVE; hosted Supabase hosts are blocked; starting next dev"
cd "$ROOT"
exec npm run dev -- "$@"
