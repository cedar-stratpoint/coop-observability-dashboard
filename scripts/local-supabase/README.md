# Local Supabase harness (throwaway, loopback only)

A real Postgres plus a real PostgREST, reached by `supabase-js` exactly like a hosted project, for end-to-end tests of
Ask Coop and Reports without ever touching a hosted Supabase project. **Local only.** Nothing here may be pointed at, or
copied to, a hosted project.

## Use

```bash
scripts/local-supabase/up.sh              # create or reuse everything, apply the SQL, smoke check (about 10 s)
scripts/local-supabase/dev.sh             # next dev against it (sources .local-env, never .env)
scripts/local-supabase/up.sh --reapply    # re-run ONLY the SQL files (also resets the pos_* fixture)
scripts/local-supabase/down.sh            # remove the two containers, the network and the proxy: clean slate
```

By hand instead of `dev.sh`: `set -a; source scripts/local-supabase/.local-env; set +a; DEV_AUTH_BYPASS=true npm run dev`.
`dev.sh` is the safe way: it also blanks every Supabase variable that `.env` declares, and preloads `block-remote.cjs`.

## What it creates

| What | Name | Port |
|---|---|---|
| Docker network (own) | `coop-local` | |
| Postgres (`supabase/postgres:17.11.0.002`) | `coop-local-db` | 127.0.0.1:54421 |
| PostgREST (`supabase/postgrest:v16.4`, max rows 1000 like hosted) | `coop-local-rest` | 127.0.0.1:54423 |
| Proxy (`proxy.mjs`, no dependencies) | host process, pid in `.proxy.pid` | 127.0.0.1:54420 |

Only the images already cached are used (nothing is pulled). No volume: `down.sh` is a clean slate. Every container and
the network carry the label `coop-local=1`, and `down.sh` refuses to touch anything without it.

`supabase-js` calls `<url>/rest/v1/<table>`; PostgREST serves `/<table>`. The proxy strips `/rest/v1`, forwards method,
headers and body, binds 127.0.0.1 only, and refuses any request whose `Host` header is not `127.0.0.1` or `localhost`.

## SQL applied, in order

1. `scripts/coop-chat-ro-fixture.sql`: the synthetic `pos_*` tables (6 orders, 4 products, events, prices).
2. `scripts/local-supabase/seed-digest.sql`: `digest_archive` with six fictional digests shaped like PROD (mixed windows, per-day data on three). The `bundle` column holds
   the marker `SHOULD-NEVER-BE-SELECTED`: if it ever shows up in a chat result, a read went wrong.
3. `supabase/coop_chat_readonly.sql`: the `coop_chat_ro` role, the seven `coop_chat_*` views, the read-only pre-request hook.
4. `supabase/coop_chat_digest.sql`: the `coop_chat_digest` view (digest columns only) for `ro_role` mode.
5. `supabase/coop_reports.sql`: skipped with a message if it does not exist yet; run `up.sh --reapply` once it does.

Each run ends with `notify pgrst, 'reload schema'`. The roles (`authenticator`, `anon`, `authenticated`, `service_role`)
come from the Postgres image; `up.sh` only sets the `authenticator` password.

## Secrets and env

First run writes `scripts/local-supabase/.local-env` (gitignored, mode 600) with random secrets: `SUPABASE_URL_ARCHIVE`
(`http://127.0.0.1:54420`), `SUPABASE_SERVICE_ROLE_KEY_ARCHIVE` (an HS256 `service_role` JWT), `CHAT_RO_JWT_SECRET`, plus
`SB_LOCAL_URL` / `SB_LOCAL_JWT_SECRET` (for `test/*local.integration.test.ts`) and `SB_URL` / `SB_JWT_SECRET` / `SB_PSQL_CMD`
(for `scripts/coop-chat-ro-proof.mjs`). Nothing is printed. To rotate: `down.sh`, delete `.local-env`, `up.sh`.

Run the local integration tests: `set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-ro-local.integration.test.ts test/chat-digest-local.integration.test.ts`.

## Safety rules

- `up.sh` and `dev.sh` abort unless `SUPABASE_URL_ARCHIVE` is `http://127.0.0.1:*` or `http://localhost:*`.
- `dev.sh` sets every Supabase-looking variable name found in `.env` / `.env.local` to the local value or to empty (Next
  never overrides a variable that is already set) and blanks the CRM proxy variables. It reads names only, never values.
- `block-remote.cjs` is preloaded (`NODE_OPTIONS=--require`): `fetch`, `http(s).request/get` and raw socket connects throw
  for any `*.supabase.co`, `*.supabase.in` or `*.supabase.net` host, and log one line. Tested offline in
  `test/local-supabase-block-remote.test.ts`.
- The database port is published on 127.0.0.1 only. Other containers on the machine are never touched.
