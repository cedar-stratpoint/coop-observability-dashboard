-- S1 · Goldline sales money encrypted at rest (Nichido project). Part 1 of 2.
-- Run on Nichido STAGING first; PROD only after review. Safe to re-run.
--
-- What it does: sales.gross_retail and sales.net_of_vat move into one encrypted column,
-- sales.amounts_enc (AES-256-CBC, random IV per row, both values in one ciphertext so a
-- read decrypts each row once). units, store/SKU codes and periods stay plain: half of
-- Goldline's SQL (checks, forecast, store scope) reads units, and units alone carry no
-- peso figures.
--
-- The key: 32 random bytes made inside this database and kept in Supabase Vault as
-- 'goldline_sales_key'. Nobody ever sees it, it is in no env var or file, and a dump of
-- this database holds only Vault's ciphertext of it (Vault's root key lives outside the
-- database). One key per environment. Losing the Vault secret loses the money figures,
-- so never delete it; the source CSVs in goldline-uploads can rebuild them.
--
-- Who can decrypt: only the SECURITY DEFINER functions below (owned by postgres, granted
-- to service_role only). No API-callable function hands out the key.
--
-- Why AES-CBC and not pgp_sym_encrypt: measured on Staging (392k rows) pgp costs ~17 µs a
-- value, so the Stores rollup would take ~14 s; raw AES with one ciphertext per row takes
-- the rollup from ~0.5 s to ~2.3 s. CBC has no integrity check, which is fine here: anyone
-- able to rewrite a ciphertext can already rewrite the row.
--
-- Rollout: this file → deploy the app (upsertSales calls upsert_sales) →
-- s2_sales_drop_plaintext.sql. Until s2, a trigger encrypts plain values an older
-- deployment still writes, so no row is left without amounts_enc.

-- 1 · The key, made once per environment.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'goldline_sales_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'goldline_sales_key',
      'AES-256 key for public.sales.amounts_enc (s1_sales_encryption.sql). Never delete.');
  end if;
end $$;

-- Not revoked: Supabase's own grant lets service_role read Vault, and postgres cannot
-- take back a grant supabase_admin made (a revoke here errors or silently does nothing).
-- What keeps the key off the API is that the vault schema is not in the project's
-- exposed schemas (Settings → API); keep it that way.

-- 2 · Helpers, in a schema PostgREST does not expose and no API role can use.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create or replace function private.goldline_sales_key()
returns bytea
language plpgsql stable security definer set search_path = ''
as $$
declare v_key bytea;
begin
  select decode(decrypted_secret, 'hex') into v_key
    from vault.decrypted_secrets where name = 'goldline_sales_key';
  if v_key is null or length(v_key) <> 32 then
    raise exception 'goldline_sales_key missing from Vault' using errcode = 'P0001';
  end if;
  return v_key;
end;
$$;

-- iv (16 bytes) || AES-256-CBC('gross|net'); a null figure is an empty part.
create or replace function private.goldline_sales_seal(p_gross numeric, p_net numeric, p_key bytea)
returns bytea
language plpgsql volatile set search_path = ''
as $$
declare v_iv bytea;
begin
  if p_gross is null and p_net is null then return null; end if;
  v_iv := extensions.gen_random_bytes(16);
  return v_iv || extensions.encrypt_iv(
    convert_to(coalesce(p_gross::text, '') || '|' || coalesce(p_net::text, ''), 'utf8'),
    p_key, v_iv, 'aes-cbc/pad:pkcs');
end;
$$;

-- Back to 'gross|net' (callers split it). Plain SQL, STABLE (convert_from is) and no SET
-- clause, so the planner inlines it: as a called function it ran ~3x slower. Every name
-- is schema-qualified instead.
create or replace function private.goldline_sales_open(p_enc bytea, p_key bytea)
returns text
language sql stable
as $$
  select pg_catalog.convert_from(
    extensions.decrypt_iv(pg_catalog.substring(p_enc, 17), p_key, pg_catalog.substring(p_enc, 1, 16), 'aes-cbc/pad:pkcs'),
    'utf8');
$$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;

-- 3 · The encrypted column, filled from the plain one.
alter table public.sales add column if not exists amounts_enc bytea;
comment on column public.sales.amounts_enc is
  'Encrypted gross_retail|net_of_vat (s1_sales_encryption.sql). Read through sales_rollup / sales_by_sku, write through upsert_sales.';

update public.sales
   set amounts_enc = private.goldline_sales_seal(gross_retail, net_of_vat, (select private.goldline_sales_key()))
 where amounts_enc is null and (gross_retail is not null or net_of_vat is not null);

-- 4 · Until s2: plain values written by an older deployment are encrypted on the way in.
create or replace function private.goldline_sales_seal_legacy()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.gross_retail is not null or new.net_of_vat is not null then
    new.amounts_enc := private.goldline_sales_seal(new.gross_retail, new.net_of_vat, private.goldline_sales_key());
  end if;
  return new;
end;
$$;
revoke all on function private.goldline_sales_seal_legacy() from public, anon, authenticated, service_role;

drop trigger if exists sales_seal_legacy on public.sales;
create trigger sales_seal_legacy before insert or update on public.sales
  for each row execute function private.goldline_sales_seal_legacy();

-- 5 · Writes: one chunk of POS rows (src/goldline-data.ts upsertSales), idempotent on
-- the natural key like the PostgREST upsert it replaces. Returns rows written.
create or replace function public.upsert_sales(p_company text, p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_key   bytea := private.goldline_sales_key();
  v_count integer;
begin
  insert into sales (company_id, store_code, sku_code, period_start, period_end, units, amounts_enc, source_upload_id)
  select p_company, r.store_code, r.sku_code, r.period_start, r.period_end, r.units,
         private.goldline_sales_seal(r.gross_retail, r.net_of_vat, v_key), r.source_upload_id
  from jsonb_to_recordset(p_rows) as r(
    store_code text, sku_code text, period_start date, period_end date,
    units integer, gross_retail numeric, net_of_vat numeric, source_upload_id uuid)
  on conflict (company_id, store_code, sku_code, period_start, period_end) do update set
    units = excluded.units, amounts_enc = excluded.amounts_enc, source_upload_id = excluded.source_upload_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.upsert_sales(text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_sales(text, jsonb) to service_role;

-- 6 · Reads: same signatures and output as before, now decrypting. Each is a chain of
-- MATERIALIZED CTEs on purpose: the key is read once per call (a plain subquery gets
-- flattened and reads Vault on every row: 22 s), and each row is decrypted once into `p`
-- before it is split (inline, the planner copies the decrypt into both halves). On Staging
-- (392k rows) sales_rollup takes ~2.3 s (was ~0.5 s); one period of sales_by_sku ~0.2 s.
create or replace function public.sales_rollup(p_company text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.store_code, s.sku_code, s.units, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
  ),
  v as materialized (
    select store_code, sku_code, units,
           nullif(split_part(p, '|', 1), '')::numeric as gross_retail,
           nullif(split_part(p, '|', 2), '')::numeric as net_of_vat
    from d
  )
  select jsonb_build_object(
    'byStore', coalesce((
      select jsonb_agg(jsonb_build_object('store_code', store_code, 'units', units, 'gross', gross, 'net', net, 'sku_count', sku_count))
      from (
        select store_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net,
               count(distinct sku_code) filter (where sku_code is not null and sku_code <> '') as sku_count
        from v group by store_code
      ) s), '[]'::jsonb),
    'bySku', coalesce((
      select jsonb_agg(jsonb_build_object('sku_code', sku_code, 'units', units, 'gross', gross, 'net', net))
      from (
        select coalesce(sku_code, '') as sku_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net
        from v group by coalesce(sku_code, '')
      ) k), '[]'::jsonb),
    'periodStart', (select min(period_start) from sales where company_id = p_company),
    'periodEnd', (select max(period_end) from sales where company_id = p_company)
  );
$$;
revoke all on function public.sales_rollup(text) from public, anon, authenticated;
grant execute on function public.sales_rollup(text) to service_role;

create or replace function public.sales_by_sku(p_company text, p_start date, p_end date)
returns table (sku_code text, units bigint, gross numeric, net numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.sku_code, s.units, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company and s.period_start = p_start and s.period_end = p_end
  )
  select coalesce(sku_code, ''), coalesce(sum(units), 0),
         coalesce(sum(nullif(split_part(p, '|', 1), '')::numeric), 0),
         coalesce(sum(nullif(split_part(p, '|', 2), '')::numeric), 0)
  from d
  group by coalesce(sku_code, '');
$$;
revoke all on function public.sales_by_sku(text, date, date) from public, anon, authenticated;
grant execute on function public.sales_by_sku(text, date, date) to service_role;
