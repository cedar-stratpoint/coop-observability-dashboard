-- coop_chat_marketplace_daily.sql
-- Owner: zoomy-observability-dashboard (Ask Coop: get_channel_report reads per-day Shopee and Lazada sales).
-- Applied BY HAND in the archive project's SQL editor, AFTER supabase/coop_chat_readonly.sql (it needs the coop_chat_ro role)
-- and after the backend's supabase/marketplace_daily_sales.sql (zoomy-observability, PR #47). Idempotent: safe to re-run.
-- Rule: knowledge/best-practices/chat-read-only.md.
--
-- marketplace_daily_sales has no customer data (a day, a channel and sales totals), but the coop_chat_ro role still never reads a
-- base table: this DEFINER view (no security_invoker) is the one door, with exactly these columns. No write is granted.

create or replace view public.coop_chat_marketplace_daily as
  select day, channel, revenue, orders, units, window_from, window_to, captured_at
  from public.marketplace_daily_sales;

revoke all on public.coop_chat_marketplace_daily from public, anon, authenticated;
grant select on public.coop_chat_marketplace_daily to coop_chat_ro;

notify pgrst, 'reload schema';
