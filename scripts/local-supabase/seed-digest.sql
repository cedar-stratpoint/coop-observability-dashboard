-- LOCAL ONLY. A minimal digest_archive (same shape as zoomy-observability/supabase/digest_archive.sql) with FICTIONAL rows,
-- so Ask Coop's get_digest can be exercised end to end. Re-runnable. Never apply to a hosted project.
-- The `bundle` column holds a marker on purpose: the E2E proves no chat read ever selects it (grep the results for it).
create table if not exists public.digest_archive (
  id           uuid primary key default gen_random_uuid(),
  window_from  timestamptz not null,
  window_to    timestamptz not null,
  bundle       jsonb not null,
  digest       jsonb not null,
  created_at   timestamptz not null default now(),
  unique (window_from, window_to)
);
alter table public.digest_archive enable row level security;   -- no policies: service role only, like the real table

-- PROD-shaped digests (spec evidence log, 2026-10-07), all FICTIONAL. Same rows as test/support/channel-report-fixture.ts:
-- three PH-aligned rows with per-day `daily` (28 Sep-4 Oct, 21-27 Sep, 1-27 Sep), an August row at UTC midnight (08:00 PH boundaries,
-- no `daily`) and two re-runs of a rolling window 30 minutes apart. September 2026: Shopee 29,800 / 65 orders / 91 units,
-- Lazada 42,400 / 91 / 120 (Sep 15 has no sales; 21-27 Sep from the newer row only).
delete from public.digest_archive where bundle->>'marker' = 'SHOULD-NEVER-BE-SELECTED';

insert into public.digest_archive (window_from, window_to, bundle, digest, created_at) values
(
  '2026-09-27T16:00:00Z', '2026-10-04T16:00:00Z',
  '{"marker": "SHOULD-NEVER-BE-SELECTED", "evidence": [{"quotes": ["SHOULD-NEVER-BE-SELECTED customer@example.test"]}]}'::jsonb,
  $d1${
    "window": {"label": "week of Sep 28 to Oct 4", "from": "2026-09-27T16:00:00.000Z", "to": "2026-10-04T16:00:00.000Z"},
    "degraded": false,
    "headline": "Lazada and Shopee both grew; Lazada led on revenue.",
    "themes": [{"theme": "joints", "displayName": "Joint pain", "quote": "FICTIONAL verbatim quote about stiff hips", "conversationId": "local-1"}],
    "comparison": {
      "shopee":  {"revenue": 5600, "orders": 14, "aov": 400, "units": 14, "adSpend": 1100, "roas": 2.9},
      "lazada":  {"revenue": 6300, "orders": 14, "aov": 450, "units": 21, "adSpend": 1400.25, "roas": 3.4},
      "website": {"revenue": 9120, "orders": 14, "aov": 651.43, "units": 25, "adSpend": null, "roas": null}
    },
    "figures": [
      {"label": "Conversations this week", "value": 37, "timeBasis": "window"},
      {"label": "Joint pain mentions", "value": 8, "timeBasis": "recurring"},
      {"label": "Total conversations (all-time)", "value": 412, "timeBasis": "allTime"}
    ],
    "recommendations": ["Restock Joint Support Chews before the weekend."],
    "sales": {
      "headline": "Website revenue was steady.",
      "figures": [{"label": "Net revenue this week (PHP)", "value": 9120, "timeBasis": "window"}, {"label": "Orders this week", "value": 14, "timeBasis": "window"}],
      "topProducts": [{"title": "Joint Support Chews", "revenue": 2400}],
      "watch": [], "recommendations": []
    },
    "customers": {
      "headline": "Two new customers.",
      "figures": [{"label": "New customers this week", "value": 2, "timeBasis": "window"}],
      "outreach": [{"name": "Maria Santos", "list": "vip", "canEmail": true, "note": "FICTIONAL outreach note"}],
      "recommendations": []
    }
  }$d1$::jsonb
  || jsonb_build_object('daily', jsonb_build_object(
    'shopee', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'revenue', 800, 'orders', 2, 'units', 2) order by d) from generate_series(date '2026-09-28', date '2026-10-04', interval '1 day') d),
    'lazada', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'revenue', 900, 'orders', 2, 'units', 3) order by d) from generate_series(date '2026-09-28', date '2026-10-04', interval '1 day') d))),
  '2026-10-05T01:00:00Z'
),
(
  '2026-09-20T16:00:00Z', '2026-09-27T16:00:00Z', '{"marker": "SHOULD-NEVER-BE-SELECTED"}'::jsonb,
  $d2${"window": {"label": "week of Sep 21 to 27", "from": "2026-09-20T16:00:00.000Z", "to": "2026-09-27T16:00:00.000Z"}, "degraded": false,
    "headline": "A quieter week on every channel.", "themes": [], "figures": [], "recommendations": [],
    "comparison": {"shopee": {"revenue": 8400, "orders": 21, "aov": 400, "units": 28, "adSpend": null, "roas": null},
                   "lazada": {"revenue": 11200, "orders": 28, "aov": 400, "units": 35, "adSpend": null, "roas": null}}}$d2$::jsonb
  || jsonb_build_object('daily', jsonb_build_object(
    'shopee', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'revenue', 1200, 'orders', 3, 'units', 4) order by d) from generate_series(date '2026-09-21', date '2026-09-27', interval '1 day') d),
    'lazada', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'revenue', 1600, 'orders', 4, 'units', 5) order by d) from generate_series(date '2026-09-21', date '2026-09-27', interval '1 day') d))),
  '2026-09-28T01:00:00Z'
),
(
  '2026-08-31T16:00:00Z', '2026-09-27T16:00:00Z', '{"marker": "SHOULD-NEVER-BE-SELECTED"}'::jsonb,
  $d3${"window": {"label": "Sep 1 to 27", "from": "2026-08-31T16:00:00.000Z", "to": "2026-09-27T16:00:00.000Z"}, "degraded": false,
    "headline": "September so far.", "themes": [], "figures": [], "recommendations": [],
    "comparison": {"shopee": {"revenue": 26000, "orders": 52, "aov": 500, "units": 78, "adSpend": null, "roas": null},
                   "lazada": {"revenue": 39000, "orders": 78, "aov": 500, "units": 104, "adSpend": null, "roas": null}}}$d3$::jsonb
  || jsonb_build_object('daily', jsonb_build_object(
    'shopee', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'revenue', 1000, 'orders', 2, 'units', 3) order by d) from generate_series(date '2026-09-01', date '2026-09-27', interval '1 day') d where d <> date '2026-09-15'),
    'lazada', (select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'revenue', 1500, 'orders', 3, 'units', 4) order by d) from generate_series(date '2026-09-01', date '2026-09-27', interval '1 day') d where d <> date '2026-09-15'))),
  '2026-09-27T20:00:00Z'
),
(
  '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '{"marker": "SHOULD-NEVER-BE-SELECTED"}'::jsonb,
  $d4${"window": {"label": "August", "from": "2026-08-01T00:00:00.000Z", "to": "2026-09-01T00:00:00.000Z"}, "degraded": false,
    "headline": "August (UTC month).", "themes": [], "figures": [], "recommendations": [],
    "comparison": {"shopee": {"revenue": 30000, "orders": 60, "aov": 500, "units": 90, "adSpend": null, "roas": null},
                   "lazada": {"revenue": 41000, "orders": 80, "aov": 512.5, "units": 110, "adSpend": null, "roas": null}}}$d4$::jsonb,
  '2026-09-01T02:00:00Z'
),
(
  '2026-07-10T03:40:00Z', '2026-08-09T03:40:00Z', '{"marker": "SHOULD-NEVER-BE-SELECTED"}'::jsonb,
  $d5${"window": {"label": "30 days", "from": "2026-07-10T03:40:00.000Z", "to": "2026-08-09T03:40:00.000Z"}, "degraded": false,
    "headline": "Re-run (newer).", "themes": [], "figures": [], "recommendations": [],
    "comparison": {"shopee": {"revenue": 28000, "orders": 56, "aov": 500, "units": 84, "adSpend": null, "roas": null}}}$d5$::jsonb,
  '2026-08-09T03:45:00Z'
),
(
  '2026-07-10T03:12:00Z', '2026-08-09T03:12:00Z', '{"marker": "SHOULD-NEVER-BE-SELECTED"}'::jsonb,
  $d6${"window": {"label": "30 days", "from": "2026-07-10T03:12:00.000Z", "to": "2026-08-09T03:12:00.000Z"}, "degraded": false,
    "headline": "Re-run (older).", "themes": [], "figures": [], "recommendations": [],
    "comparison": {"shopee": {"revenue": 27900, "orders": 55, "aov": 507.27, "units": 83, "adSpend": null, "roas": null}}}$d6$::jsonb,
  '2026-08-09T03:15:00Z'
)
on conflict (window_from, window_to) do update set bundle = excluded.bundle, digest = excluded.digest, created_at = excluded.created_at;

-- Roles PostgREST uses for the service-role key (the hosted project grants these by default).
grant select, insert, update, delete on public.digest_archive to service_role;
