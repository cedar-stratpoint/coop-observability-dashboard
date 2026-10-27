// `compare_sku`: one product side by side across offline (POS), Shopee and the website, over whole Monday to Sunday weeks (plan 2026-10-22, D1/D2;
// contract knowledge/tasks/2026-10-26-sku-compare-contract.md). The comparison itself is src/sku-compare.ts (pure, tested); this module only
//  - validates the model's input in code (the tool is NOT strict: it must not touch the compiled-grammar cap),
//  - wires the three readers to what a chat turn already holds (POS data, the Shopee weekly rows and alias table from the server seam, the CRM client),
//  - shapes `SkuComparison` for the chat: rows per channel (so a chart never double counts), the total in `meta.totals`, and every statement the
//    answer must make (basis, coverage, mixed basis, "at least", unmapped share, website mapping unverified) as a code-written check the model quotes.
// Pure apart from the injected loaders and CRM read.
import {phDay} from '../custom-range';
import {
  compareSku, CHANNEL_LABEL, weekContaining, type AliasRow, type ChannelResult, type SkuComparison,
} from '../sku-compare';
import {posReader, shopeeReader, websiteReader, type ShopeeSkuRow} from '../sku-compare-readers';
import {rangeLabel} from './range';
import type {Check, MeasureDecl, MetricData, MetricError, MetricResult, MetricRow, ResultColumn} from './result-types';
import type {CrmGet} from './crm/tools';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: 2026-02-30 rolls over in Date.parse, so the round trip must give the same text. */
const realDay = (d: string): boolean => DAY.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
const MAX_WEEKS = 13;
const fail = (error: string): MetricError => ({error});

export interface CompareRequest {
  sku: string;
  from: string;
  to: string;
}

/** Only sku, from, to. The dates are the owner's; a week is Monday to Sunday ("the week of 12 Oct" is Mon 12 to Sun 18). */
export function readCompareInput(input: unknown): CompareRequest | MetricError {
  const keys = 'Use only these parameters: sku (the POS product code), from and to (YYYY-MM-DD, a Monday and a Sunday).';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail(keys);
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'sku' && k !== 'from' && k !== 'to') || typeof o.sku !== 'string' || typeof o.from !== 'string' || typeof o.to !== 'string') return fail(keys);
  const sku = o.sku.trim().toUpperCase();
  if (!SKU.test(sku)) return fail('sku must be the product code itself (letters, digits, dashes), for example ZMYFDMEATBEFWHL01. If the owner gave a name, find its code with lookup_product first; do not guess one.');
  if (!realDay(o.from) || !realDay(o.to)) return fail('from and to must be the owner\'s dates as YYYY-MM-DD. Ask the owner if they gave none; do not pick dates yourself.');
  if (o.to < o.from) return fail('from is after to. Ask the owner for the dates again.');
  if (Math.round((Date.parse(`${o.to}T00:00:00Z`) - Date.parse(`${o.from}T00:00:00Z`)) / 86_400_000) + 1 > MAX_WEEKS * 7) return fail(`That is more than ${MAX_WEEKS} weeks. Ask the owner for a shorter range.`);
  return {sku, from: o.from, to: o.to};
}

export interface CompareDeps {
  /** The turn's POS data (same load as every other POS tool). */
  data: () => Promise<MetricData>;
  /** product_channel_alias rows, from the server seam. */
  aliases: () => Promise<AliasRow[]>;
  /** marketplace_sku_weekly rows for the weeks from `from` to `to`. */
  shopee: (from: string, to: string) => Promise<ShopeeSkuRow[]>;
  /** The CRM read for the website channel; absent means the website is not connected here. Goes through the executor's audited, capped client. */
  crmGet?: CrmGet;
  now: Date;
}

/** Read the three channels and compare. A channel that cannot be read is named in the result (status failed / not_connected), never silently dropped. */
export async function compareForChat(req: CompareRequest, deps: CompareDeps): Promise<SkuComparison> {
  const data = await deps.data();
  const aliases = await deps.aliases().catch(() => [] as AliasRow[]); // an unreadable alias table means every Shopee and website row is unmapped, and the result says so
  const crmGet = deps.crmGet;
  const aligned = weekContaining(req.from).from === req.from;
  const shopeeRows = aligned ? await deps.shopee(req.from, req.to).catch(() => null) : [];
  return compareSku({
    sku: req.sku,
    from: req.from,
    to: req.to,
    aliases,
    channels: ['pos', 'shopee', 'website'],
    readers: {
      pos: posReader(data),
      ...(shopeeRows === null ? {} : {shopee: shopeeReader(shopeeRows)}), // no shop week totals are wired yet: Shopee coverage is reported as unknown
      ...(crmGet
        ? {
            website: websiteReader(async (from, to) => {
              // an unreadable CRM must fail the channel (named), not look like "no sales": the CrmError propagates to compareSku's reader guard
              const r = await crmGet('productSales', {from, to, group_by: 'sku', limit: 200, financial_status: 'paid'}, {paged: true}); // paged: one read per week, counted apart from the CRM tools' own per-turn GET cap
              return r.body;
            }),
          }
        : {}),
    },
  });
}

/* ---------- the stored result and the statements the answer must make ---------- */

const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});
const COLUMNS: ResultColumn[] = [
  col('channel', 'Channel', 'text', 'category'),
  col('units', 'Units', 'units', 'measure'),
  col('revenue', 'Revenue', 'PHP', 'measure'),
  col('unmapped_units', 'Units not matched to a SKU', 'units', 'measure'),
];
const MEASURE: MeasureDecl = {key: 'units', label: 'Units of the SKU', kind: 'derived', unit: 'units', method: 'Units sold of this SKU per channel, over whole Monday to Sunday weeks. Only rows matched to the SKU through the alias table are counted; each channel keeps its own basis.'};
const peso = (n: number): string => `₱${n.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 2})}`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const warn = (text: string): Check => ({code: 'partial_coverage', status: 'warn', text});
const info = (text: string): Check => ({code: 'partial_coverage', status: 'info', text});

function channelStatements(c: ChannelResult): Check[] {
  const name = CHANNEL_LABEL[c.channel];
  const out: Check[] = [];
  if (c.status === 'not_connected' || c.status === 'failed') {
    out.push(warn(`${name}: ${c.status === 'failed' ? 'could not be read just now' : 'is not connected here'}. Its figure is missing, so the total is partial. Say so and give no ${name} number.`));
    return out;
  }
  if (c.status === 'no_data') out.push(warn(`${name}: no data for these weeks (say "no data", not zero).`));
  else {
    const rev = c.revenue === null ? 'revenue not shown (a combo listing is in it)' : `revenue ${peso(c.revenue)}`;
    out.push(info(`${name}: ${c.units} unit${c.units === 1 ? '' : 's'}, ${rev}. Basis: ${c.basis}.${c.allocated ? ' Part of this is an allocation of bundle prices.' : ''}`));
    if (c.channel === 'website' && c.status === 'ok') out.push(info('Website counts paid orders only (financial status paid), from the CRM\'s line items.'));
    if (!c.exact) out.push(warn(`${name} is NOT the whole channel: ${c.channel === 'shopee' ? `it lists only the top performing products${c.coveragePct === null ? ' and its coverage of the shop is unknown' : `, covering at least ${c.coveragePct.toFixed(0)}% of the week's shop sales`}` : 'part of its weeks or rows are missing'}. Call its units "at least".`));
    if (c.coveragePct !== null && c.channel === 'shopee') out.push(info(`Shopee coverage: the products listed make up ${c.coveragePct.toFixed(0)}% of the shop's confirmed sales in the weakest week.`));
  }
  if (!c.mappingVerified) out.push(warn(`${name} mapping is UNVERIFIED: whether its SKU equals the POS code has not been confirmed, so its rows count only through confirmed aliases. Say so.`));
  if (c.weeksMissing.length && c.status === 'ok') out.push(warn(`${name} has no data for the week${c.weeksMissing.length > 1 ? 's' : ''} of ${c.weeksMissing.join(', ')}.`));
  if (c.unmapped.rows > 0) {
    out.push(warn(`${name}: ${c.unmapped.rows} row${c.unmapped.rows === 1 ? '' : 's'} (${c.unmapped.units} unit${c.unmapped.units === 1 ? '' : 's'}${c.unmapped.shareOfUnits === null ? '' : `, ${pct(c.unmapped.shareOfUnits)} of the channel's units`}) have no confirmed alias and are NOT in any SKU. State this unmapped share.`));
  } else if (c.status === 'ok') out.push(info(`${name}: no unmapped rows in these weeks.`));
  for (const n of c.notes) if (!out.some((o) => o.text.includes(n))) out.push(info(n));
  return out;
}

/** The stored result for the chat: rows per channel, the total (when the weeks are whole) in `meta.totals`, every required statement as a check. */
export function skuCompareResult(cmp: SkuComparison, now: Date): MetricResult {
  const rows: MetricRow[] = cmp.channels
    .filter((c) => c.status === 'ok')
    .map((c) => ({channel: CHANNEL_LABEL[c.channel], units: c.units, revenue: c.revenue, unmapped_units: c.unmapped.units}));
  const checks: Check[] = [info(`SKU ${cmp.sku}, ${rangeLabel(cmp.from, cmp.to)}${cmp.aligned ? ` (${cmp.weeks.length} whole Monday to Sunday week${cmp.weeks.length === 1 ? '' : 's'})` : ''}. Every figure below was computed in code from each channel's own data; quote it, do not recompute.`)];
  for (const n of cmp.notes) checks.push(warn(n));
  for (const c of cmp.channels) checks.push(...channelStatements(c));
  const t = cmp.combined;
  if (t) {
    checks.push(
      info(`Total over ${t.channels.map((c) => CHANNEL_LABEL[c]).join(', ')}: ${t.units} units, ${peso(t.revenue)}, label "${t.label}"${t.partial ? ', PARTIAL' : ''}${t.mixedBasis ? ', MIXED BASIS (the channels count sales differently: say so)' : ''}. ${t.note}`),
    );
    if (t.label === 'at least' || t.partial) checks.push(warn(`Say "at least ${t.units} units" for the total${t.missing.length ? `; missing or short: ${t.missing.map((c) => CHANNEL_LABEL[c]).join(', ')}` : ''}.`));
  } else if (!cmp.aligned) checks.push(warn('No total is given because these dates are not whole Monday to Sunday weeks.'));
  if (cmp.unmapped.rows > 0) checks.push(warn(`Across channels ${cmp.unmapped.rows} row${cmp.unmapped.rows === 1 ? '' : 's'} (${cmp.unmapped.units} unit${cmp.unmapped.units === 1 ? '' : 's'}) are unmapped: kept apart, never added to a SKU.`));
  for (const i of cmp.issues) checks.push(warn(`Alias ${i.kind} (${i.channel} ${i.alias_type} ${i.alias_value}): ${i.detail}`));
  const today = phDay(now.getTime());
  return {
    id: '',
    metric: 'sku_compare',
    dimension: 'channel',
    columns: COLUMNS,
    rows,
    meta: {
      source: 'live',
      range: {from: cmp.from, to: cmp.to, label: rangeLabel(cmp.from, cmp.to)},
      dataFrom: cmp.from,
      dataTo: cmp.to,
      rowCount: rows.length,
      coverage: cmp.channels.every((c) => c.status === 'ok' && c.weeksMissing.length === 0) ? 'full' : cmp.channels.some((c) => c.status === 'ok') ? 'partial' : 'none',
      coveredFrom: cmp.from,
      coveredTo: cmp.to <= today ? cmp.to : today,
      caveats: checks.map((c) => c.text),
      share_basis: null,
      measure: MEASURE.key,
      measures: [MEASURE],
      insights: [],
      checks,
      reliable: true,
      ...(t
        ? {
            totals: [
              {
                label: `${cmp.sku} units across ${t.channels.map((c) => CHANNEL_LABEL[c]).join(', ')} (${t.label})`,
                channels_included: t.channels.map((c) => CHANNEL_LABEL[c]),
                channels_excluded: t.missing.map((c) => ({channel: CHANNEL_LABEL[c], reason: 'not usable for every week'})),
                status: t.partial || t.label === 'at least' ? ('partial' as const) : ('complete' as const), // "at least" is not the whole channel set: never shown as complete
                revenue: t.revenue,
                orders: null,
                units: t.units,
                aov: null,
                note: t.note,
                calculated_in_code: true as const,
              },
            ],
          }
        : {}),
    },
  };
}
