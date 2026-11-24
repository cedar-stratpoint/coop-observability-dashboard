-- F12 · Purchase orders (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review. Needs p3b_recommendations.sql.
--
-- Decided Nov 3 (plan: "Approved lines become a PO laid out like the paper form"):
--   • The owner approves, edits or rejects on the Restock run (F11). That is the only
--     decision: a PO carries it, it doesn't ask again. Its Line and Remarks columns show
--     the F11 decision and remark, like Nichido's paper PURCHASE ORDER FORM.
--   • One PO per store per day (po_date, Manila), within a restock run. Making POs puts the
--     run's approved and edited lines on that day's PO for each store and ships each line
--     through record_shipment (warehouse goes down, the line is on the way). Lines
--     approved later and sent on another day go on a new PO (Nov 4). A short warehouse
--     stops the whole call; nothing is made.
--   • The received section takes qty and date per line. The shipment is then 'received'
--     and stays "on the way" only until the store's next count covers the received date.
--     A short receipt is kept as entered; the missing units are not put back in the
--     warehouse (v1).
--   • Received qty counts as delivered in the form vs. sales check (F6) and the board (F9),
--     over the form's Delivery column, for the same store, item and period.
--   • PO status is worked out from its lines (src/goldline-po.ts), not stored.
--
--   purchase_orders          one row per run × store × day, numbered per company (PO-0042).
--   po_lines                 one row per shipped recommendation.
--   shipments                + 'received' status, received_qty, received_on.
--   make_purchase_orders()   put the run's approved lines on each store's PO and ship them.
--   receive_po_lines()       record what arrived.
--   po_dates()               the Orders page's date tiles, added up per day (Nov 4).
--   decide_recommendations() redefined: changing a line already on a PO takes it back
--                            off (its shipment is cancelled) while that's still possible.

create table if not exists public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  company_id  text not null references public.companies(id) on delete cascade,
  po_no       integer not null check (po_no > 0),
  run_id      uuid not null references public.restock_runs(id) on delete restrict,
  store_code  text not null,
  po_date     date not null default ((now() at time zone 'Asia/Manila')::date), -- the paper form's "Date"
  module      text,                       -- the paper form's "Module" field (free text for now)
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  unique (company_id, po_no),
  unique (run_id, store_code, po_date)
);
-- Nov 4: one PO per store per day, not per run (staging had the per-run key for a day).
alter table public.purchase_orders add column if not exists po_date date;
update public.purchase_orders set po_date = (created_at at time zone 'Asia/Manila')::date where po_date is null;
alter table public.purchase_orders alter column po_date set default ((now() at time zone 'Asia/Manila')::date), alter column po_date set not null;
alter table public.purchase_orders drop constraint if exists purchase_orders_run_id_store_code_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_run_id_store_code_po_date_key') then
    alter table public.purchase_orders add constraint purchase_orders_run_id_store_code_po_date_key unique (run_id, store_code, po_date);
  end if;
end $$;
create index if not exists purchase_orders_company_idx on public.purchase_orders (company_id, created_at desc);
create index if not exists purchase_orders_date_idx on public.purchase_orders (company_id, po_date desc);
alter table public.purchase_orders enable row level security;
revoke all on public.purchase_orders from anon, authenticated;

alter table public.shipments add column if not exists received_qty integer check (received_qty is null or received_qty >= 0);
alter table public.shipments add column if not exists received_on date;
alter table public.shipments drop constraint if exists shipments_status_check;
alter table public.shipments add constraint shipments_status_check check (status in ('in_transit', 'cancelled', 'received'));
alter table public.shipments drop constraint if exists shipments_received;
alter table public.shipments add constraint shipments_received check (status <> 'received' or (received_qty is not null and received_on is not null));

create table if not exists public.po_lines (
  id                uuid primary key default gen_random_uuid(),
  po_id             uuid not null references public.purchase_orders(id) on delete cascade,
  company_id        text not null references public.companies(id) on delete cascade,
  recommendation_id uuid not null unique references public.recommendations(id) on delete restrict,
  store_code        text not null,
  item_code         text not null,
  qty               integer not null check (qty > 0),
  unit_price        numeric,              -- the catalog price when the line was added
  shipment_id       uuid not null references public.shipments(id) on delete restrict,
  received_qty      integer check (received_qty is null or (received_qty >= 0 and received_qty <= qty)),
  received_on       date,
  received_by       text,
  received_at       timestamptz,
  created_at        timestamptz not null default now(),
  constraint po_lines_received check ((received_qty is null) = (received_on is null))
);
create index if not exists po_lines_po_idx on public.po_lines (po_id);
create index if not exists po_lines_received_idx on public.po_lines (company_id, store_code, received_on) where received_qty is not null;
alter table public.po_lines enable row level security;
revoke all on public.po_lines from anon, authenticated;

-- Put the run's approved and edited lines (more than 0 to send) on each store's PO for
-- p_today and ship them (record_shipment; not_enough_stock:N stops the whole call). A
-- store gets a new PO the first time it has such a line on a day; lines already on a PO
-- are skipped, so running it again only adds what's new (to today's PO). p_stores narrows to a store-scoped role's stores
-- (null = every store). Returns {"pos": new POs, "lines": lines added}.
create or replace function public.make_purchase_orders(
  p_company text, p_run uuid, p_by text, p_stores text[] default null, p_today date default current_date
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare
  v_store text;
  v_rec   record;
  v_po    uuid;
  v_ship  uuid;
  v_pos   integer := 0;
  v_lines integer := 0;
begin
  if not exists (select 1 from restock_runs where id = p_run and company_id = p_company) then
    raise exception 'run_not_found' using errcode = 'P0001';
  end if;
  -- PO numbers are max + 1 per company; one maker at a time.
  perform pg_advisory_xact_lock(hashtext('purchase_orders:' || p_company));

  for v_rec in
    select r.id, r.store_code, r.item_code, r.final_qty, p.unit_price
    from recommendations r
    left join products p on p.company_id = r.company_id and p.item_code = r.item_code
    where r.company_id = p_company and r.run_id = p_run
      and r.decision in ('approved', 'edited') and r.final_qty > 0
      and (p_stores is null or r.store_code = any(p_stores))
      and not exists (select 1 from po_lines pl where pl.recommendation_id = r.id)
    order by r.store_code, r.item_code
    for update of r
  loop
    if v_store is distinct from v_rec.store_code then
      v_store := v_rec.store_code;
      select id into v_po from purchase_orders where run_id = p_run and store_code = v_store and po_date = p_today;
      if v_po is null then
        insert into purchase_orders (company_id, po_no, run_id, store_code, po_date, created_by, updated_by)
        values (p_company, (select coalesce(max(po_no), 0) + 1 from purchase_orders where company_id = p_company), p_run, v_store, p_today, p_by, p_by)
        returning id into v_po;
        v_pos := v_pos + 1;
      else
        update purchase_orders set updated_by = p_by, updated_at = now() where id = v_po;
      end if;
    end if;
    v_ship := record_shipment(p_company, v_rec.store_code, v_rec.item_code, v_rec.final_qty, p_by, p_today);
    insert into po_lines (po_id, company_id, recommendation_id, store_code, item_code, qty, unit_price, shipment_id)
    values (v_po, p_company, v_rec.id, v_rec.store_code, v_rec.item_code, v_rec.final_qty, v_rec.unit_price, v_ship);
    v_lines := v_lines + 1;
  end loop;
  return jsonb_build_object('pos', v_pos, 'lines', v_lines);
end;
$$;
revoke all on function public.make_purchase_orders(text, uuid, text, text[], date) from public, anon, authenticated;
grant execute on function public.make_purchase_orders(text, uuid, text, text[], date) to service_role;

-- The received section. p_lines: [{"id": uuid, "qty": int | null, "date": "YYYY-MM-DD" | null}].
-- qty 0 to the line's qty; the date can't be before the shipment left or after p_today.
-- qty null clears a receipt (the shipment is back in transit). Returns the lines changed.
create or replace function public.receive_po_lines(
  p_company text, p_lines jsonb, p_by text, p_stores text[] default null, p_today date default current_date
) returns integer
language plpgsql security invoker set search_path = public
as $$
declare
  v_in    record;
  v_line  record;
  v_left  date;
  v_count integer := 0;
begin
  for v_in in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as x(id uuid, qty integer, date date)
  loop
    select pl.* into v_line from po_lines pl
    where pl.id = v_in.id and pl.company_id = p_company
      and (p_stores is null or pl.store_code = any(p_stores))
    for update;
    if v_line.id is null then raise exception 'line_not_found' using errcode = 'P0001'; end if;

    if v_in.qty is null then
      update po_lines set received_qty = null, received_on = null, received_by = null, received_at = null where id = v_line.id;
      update shipments set status = 'in_transit', received_qty = null, received_on = null
      where id = v_line.shipment_id and company_id = p_company and status = 'received';
    else
      if v_in.qty < 0 or v_in.qty > v_line.qty then raise exception 'over_qty' using errcode = 'P0001'; end if;
      select shipped_on into v_left from shipments where id = v_line.shipment_id and company_id = p_company;
      if v_in.date is null or v_in.date < v_left or v_in.date > p_today then raise exception 'bad_date' using errcode = 'P0001'; end if;
      update po_lines set received_qty = v_in.qty, received_on = v_in.date, received_by = p_by, received_at = now() where id = v_line.id;
      update shipments set status = 'received', received_qty = v_in.qty, received_on = v_in.date
      where id = v_line.shipment_id and company_id = p_company and status in ('in_transit', 'received');
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.receive_po_lines(text, jsonb, text, text[], date) from public, anon, authenticated;
grant execute on function public.receive_po_lines(text, jsonb, text, text[], date) to service_role;

-- The Orders page's date tiles: one row per day POs were made, added up here so the page
-- never reads every PO and line (a year is ~50 to 70 dates, tens of thousands of lines).
-- p_stores narrows to a store-scoped role's stores (null = every store).
create or replace function public.po_dates(p_company text, p_stores text[] default null)
returns table (po_date date, pos integer, lines integer, received integer, total numeric, cycles text[])
language sql stable security invoker set search_path = public
as $$
  select po.po_date,
         count(distinct po.id)::integer,
         count(pl.id)::integer,
         count(pl.id) filter (where pl.received_qty is not null)::integer,
         coalesce(sum(pl.qty * pl.unit_price), 0),
         array_agg(distinct rr.cycle order by rr.cycle)
  from purchase_orders po
  join po_lines pl on pl.po_id = po.id
  join restock_runs rr on rr.id = po.run_id
  where po.company_id = p_company
    and (p_stores is null or po.store_code = any(p_stores))
  group by po.po_date
  order by po.po_date desc;
$$;
revoke all on function public.po_dates(text, text[]) from public, anon, authenticated;
grant execute on function public.po_dates(text, text[]) to service_role;

-- decide_recommendations (p3b) with one change for lines already on a PO (shipped):
-- changing or undoing one takes it back off its PO and cancels its shipment (the units go
-- back to the warehouse), so the next "make purchase orders" ships the new number. That's
-- refused once the stock is received (already_received) or due to have arrived
-- (cancel_shipment's already_arrived).
create or replace function public.decide_recommendations(
  p_company text, p_ids uuid[], p_decision text, p_qty integer, p_remark text, p_by text, p_stores text[] default null
) returns integer
language plpgsql security invoker set search_path = public
as $$
declare
  v_remark text := nullif(btrim(coalesce(p_remark, '')), '');
  v_line   record;
  v_count  integer;
begin
  if p_decision not in ('approved', 'edited', 'rejected', 'pending') then raise exception 'bad_decision' using errcode = 'P0001'; end if;
  if p_decision in ('edited', 'rejected') and v_remark is null then raise exception 'remark_required' using errcode = 'P0001'; end if;
  if p_decision = 'edited' and (p_qty is null or p_qty < 0) then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  if p_decision = 'edited' and coalesce(array_length(p_ids, 1), 0) <> 1 then raise exception 'edit_one' using errcode = 'P0001'; end if;

  -- Take shipped lines back off their PO first, so their units are in the warehouse
  -- again before an edit is checked against it.
  for v_line in
    select pl.* from po_lines pl
    where pl.company_id = p_company and pl.recommendation_id = any(p_ids)
      and (p_stores is null or pl.store_code = any(p_stores))
    for update
  loop
    if v_line.received_qty is not null then raise exception 'already_received' using errcode = 'P0001'; end if;
    perform cancel_shipment(p_company, v_line.shipment_id, p_by, (now() at time zone 'Asia/Manila')::date);
    delete from po_lines where id = v_line.id;
  end loop;

  if p_decision = 'edited' and exists (
    select 1 from recommendations r
    left join warehouse_stock w on w.company_id = r.company_id and w.item_code = r.item_code
    where r.company_id = p_company and r.id = any(p_ids) and p_qty > coalesce(w.on_hand, 0)
  ) then raise exception 'over_warehouse' using errcode = 'P0001'; end if;

  update recommendations r set
    decision   = case when p_decision = 'edited' and p_qty = r.suggested then 'approved' else p_decision end,
    final_qty  = case p_decision when 'approved' then r.suggested when 'edited' then p_qty when 'rejected' then 0 else null end,
    remark     = case when p_decision = 'pending' then null else v_remark end,
    decided_by = case when p_decision = 'pending' then null else p_by end,
    decided_at = case when p_decision = 'pending' then null else now() end
  where r.company_id = p_company
    and r.id = any(p_ids)
    and r.suggested > 0
    and r.holds = '{}'
    and (p_stores is null or r.store_code = any(p_stores));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.decide_recommendations(text, uuid[], text, integer, text, text, text[]) from public, anon, authenticated;
grant execute on function public.decide_recommendations(text, uuid[], text, integer, text, text, text[]) to service_role;
