-- F2g · Longer statement timeout for the dashboard's server reads (Nichido project).
-- Safe to re-run. Run on Nichido STAGING first; PROD after review.
--
-- Oct 29: SKU linking on prod failed on most loads with "canceling statement due to
-- statement timeout". sales_rollup decrypts every sales row (472k on prod, ~4.8 s alone),
-- so two or three overlapping loads went past PostgREST's 8 s default (set on the
-- authenticator role). The dashboard calls the API as service_role only, so this raises
-- the limit for that role alone; anon and authenticated keep 8 s. PostgREST applies the
-- impersonated role's statement_timeout per request. Stopgap with the app-side cache of
-- the sales totals (v1.19.1); the lasting fix is pre-added totals (with Rick).

alter role service_role set statement_timeout = '30s';
notify pgrst, 'reload config';
