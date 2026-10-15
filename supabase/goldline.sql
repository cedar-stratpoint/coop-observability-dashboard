-- Goldline (Nichido) data model — P1.
--
-- The `gl_*` tables for Goldline's inventory + POS data, modeled directly on the
-- two real source documents (POS sales export + the semi-monthly inventory form).
-- Every row carries company_id; everything store-level carries a store code.
-- ADDITIVE ONLY — nothing here touches Coop's existing tables or pos_*. Depends on
-- companies.sql (run that first). Run on STAGING (syxwixxzmytvhwhkwdvw) first.
--
-- RLS is on with NO policies on every table: the anon key reads nothing, only the
-- service role (the Coop server) gets through. App-level scoping by the active
-- company_id (src/company.ts) is the primary fence; this RLS is the backstop.
--
-- Scale note: gl_sales / gl_inventory are store × SKU × period. At 300 stores and
-- ~500 SKUs that is ~150k rows per cycle, modest for Postgres. Reads go through the
-- paginator (fetchAllRows) + the indexes below; monthly partitioning is the later
-- optimization if volume grows, not needed for v1.

-- Stores — the location dimension (region → area → store).
create table if not exists public.gl_stores (
  company_id text not null references public.companies(id) on delete cascade,
  store_code text not null,                 -- POS "Location", e.g. '1'
  name       text not null,                 -- "Location Desc", e.g. 'CUBAO'
  region     text,                          -- assigned (not in the source files)
  area       text,
  status     text not null default 'active',
  opened_on  date,
  primary key (company_id, store_code)
);

-- Product catalog + the SKU crosswalk: inventory `item_code` (FBPP01) ↔ POS
-- numeric `sku_code` (38005997). This is what joins the two source files.
create table if not exists public.gl_products (
  company_id    text not null references public.companies(id) on delete cascade,
  item_code     text not null,              -- inventory-form Item #, e.g. 'FBPP01'
  sku_code      text,                       -- POS SKU Code (numeric), e.g. '38005997'
  product_line  text,                       -- e.g. 'Flawless Beauty Pressed Powder'
  variant       text,                       -- e.g. 'Salmon'
  unit_price    numeric,
  is_bestseller boolean not null default false,
  primary key (company_id, item_code)
);
create index if not exists gl_products_sku_idx
  on public.gl_products (company_id, sku_code);

-- POS sales — one row per store × SKU × period (the detail table; summaries are
-- derived from it). Idempotent on the natural key so a re-uploaded export upserts.
create table if not exists public.gl_sales (
  id               bigint generated always as identity primary key,
  company_id       text not null references public.companies(id) on delete cascade,
  store_code       text not null,
  sku_code         text not null,
  period_start     date not null,
  period_end       date not null,
  gross_retail     numeric,                 -- "Gross Sales Retail TY"
  units            integer,                 -- "Sales Units TY"
  net_of_vat       numeric,                 -- "Sales Net of Vat Net of Discount"
  source_upload_id uuid,
  created_at       timestamptz not null default now(),
  unique (company_id, store_code, sku_code, period_start, period_end)
);
create index if not exists gl_sales_store_period_idx
  on public.gl_sales (company_id, store_code, period_start);
create index if not exists gl_sales_sku_period_idx
  on public.gl_sales (company_id, sku_code, period_start);

-- Inventory — the handwritten semi-monthly form, one row per store × SKU × cycle.
-- The five count columns come straight off the form; total_value is DERIVED
-- (ending_on_hand × unit_price) downstream, never OCR'd.
create table if not exists public.gl_inventory (
  id               bigint generated always as identity primary key,
  company_id       text not null references public.companies(id) on delete cascade,
  store_code       text not null,
  item_code        text not null,
  period_start     date not null,
  period_end       date not null,
  consultant       text,                    -- "Beauty Consultant"
  stockroom        integer,                 -- col1 Bilang sa Stockroom/Steelcab
  drawer           integer,                 -- col2 Bilang sa Drawer/Module
  selling_area     integer,                 -- col3 Bilang sa Selling Area
  delivery         integer,                 -- col4 Delivery
  ending_on_hand   integer,                 -- col5 Ending Inventory (Stock on Hand)
  total_value      numeric,                 -- col6 derived (ending × price)
  source_upload_id uuid,
  created_at       timestamptz not null default now(),
  unique (company_id, store_code, item_code, period_start, period_end)
);
create index if not exists gl_inventory_store_period_idx
  on public.gl_inventory (company_id, store_code, period_start);
create index if not exists gl_inventory_item_period_idx
  on public.gl_inventory (company_id, item_code, period_start);

-- Uploads — every file dropped on the Uploads page.
-- status: processing | needs_review | committed | failed | rejected
--   rejected = wrong type/oversized (blocked at the gate); failed = accepted but
--   could not parse. kind: 'pos_csv' | 'inventory_pdf'.
create table if not exists public.gl_uploads (
  id          uuid primary key default gen_random_uuid(),
  company_id  text not null references public.companies(id) on delete cascade,
  kind        text not null,
  filename    text not null,
  storage_path text,
  status      text not null default 'processing',
  page_count  integer,
  reject_reason text,
  uploaded_by text,                         -- email
  created_at  timestamptz not null default now()
);
create index if not exists gl_uploads_company_created_idx
  on public.gl_uploads (company_id, created_at desc);

-- Extractions — Claude Vision's per-page output, staged for human review before it
-- commits to gl_inventory. `rows` is the extracted rows + per-field confidence;
-- doc_confidence is the page-level roll-up. status: pending_review|confirmed|rejected.
create table if not exists public.gl_extractions (
  id             uuid primary key default gen_random_uuid(),
  company_id     text not null references public.companies(id) on delete cascade,
  upload_id      uuid not null references public.gl_uploads(id) on delete cascade,
  page           integer not null,
  rows           jsonb,
  doc_confidence numeric,
  status         text not null default 'pending_review',
  created_at     timestamptz not null default now(),
  unique (upload_id, page)
);

-- Per-company derived analytics (so dashboards read small summaries, not raw rows).
-- The unifying view in companies work tags legacy Zoomy rows company_id='zoomy';
-- new brands write here.
create table if not exists public.company_digest_archive (
  id          bigint generated always as identity primary key,
  company_id  text not null references public.companies(id) on delete cascade,
  window_from date not null,
  window_to   date not null,
  digest      jsonb,
  created_at  timestamptz not null default now(),
  unique (company_id, window_from, window_to)
);

create table if not exists public.company_business_health (
  id          bigint generated always as identity primary key,
  company_id  text not null references public.companies(id) on delete cascade,
  window_from date not null,
  window_to   date not null,
  snapshot    jsonb,
  created_at  timestamptz not null default now(),
  unique (company_id, window_from, window_to)
);

-- RLS on, no policies (service-role only) for every table above.
alter table public.gl_stores               enable row level security;
alter table public.gl_products             enable row level security;
alter table public.gl_sales                enable row level security;
alter table public.gl_inventory            enable row level security;
alter table public.gl_uploads              enable row level security;
alter table public.gl_extractions          enable row level security;
alter table public.company_digest_archive  enable row level security;
alter table public.company_business_health enable row level security;
