// F4: the per-turn coverage block and the static catalog for the cached system prompt. Pure.
import {windowLabel, type DigestWindow} from '../digest-windows';
import {notInDatabaseText, type DataFlags} from './catalog/prompt';
import {buildCoverage, phtDate} from './coverage';
import {METRICS, METRIC_IDS} from './metrics-registry';
import type {MetricData} from './result-types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const shortDate = (key: string): string => `${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

function longToday(now: Date): string {
  const pht = new Date(now.getTime() + 8 * 3600_000);
  return `${WEEKDAYS[pht.getUTCDay()]}, ${pht.getUTCDate()} ${FULL_MONTHS[pht.getUTCMonth()]} ${pht.getUTCFullYear()}`;
}

const PET_EVENT = 'Pet type and event ARE available (pet_mix, event_rollup): run once per event or pet.';
// Where each sales channel is read from, per CRM state (none / get_channel_report only / the CRM tools too). The catalog-built
// "Not in the database" line then names what still is not readable, from the same flags.
const salesSources = (flags: DataFlags): string =>
  flags.crm
    ? 'Shopee/Lazada sales (stored digests only). Website orders, customers and abandoned checkouts ARE available live (get_crm_metrics, list_crm_orders, list_crm_customers, list_crm_checkouts).'
    : flags.website
      ? 'Shopee/Lazada sales (stored digests only). Website totals for any dates ARE available live through get_channel_report; other Website figures come from the stored digests only.'
      : 'Shopee/Lazada/Website sales (stored digests only).';
const notAvailableBase = (flags: DataFlags): string => `Not available: Traffic (sample data only), Meta ads (not connected), ${salesSources(flags)} ${notInDatabaseText(flags)} ${PET_EVENT}`;
const NOT_AVAILABLE_NO_EXPLORE = 'Contact details (email, phone, instagram) are not exposed by the metrics. Questions no metric covers cannot be answered.';
const NOT_AVAILABLE_NO_EXPLORE_CRM = 'POS contact details are not exposed by the metrics; website customer contacts come from list_crm_customers. Other questions no tool covers cannot be answered.';
const EXPLORE_AVAILABLE = 'For questions no metric covers (contacts, leads, stock lots and movements, saved reports, voided orders, hours), use list_tables, describe_table and run_query on the database tables.';
const notAvailable = (explore: boolean, flags: DataFlags = {}): string =>
  `${notAvailableBase(flags)} ${explore ? EXPLORE_AVAILABLE : flags.crm ? NOT_AVAILABLE_NO_EXPLORE_CRM : NOT_AVAILABLE_NO_EXPLORE}`;

/** Per-turn context when the live-data path is unavailable: today's date and an honest "not available" (no data, no figures). */
export function buildDegradedPreamble(now: Date): string {
  return `[context] Today is ${longToday(now)} (Philippine time; ${phtDate(now)}). Live offline POS data is not available right now. ${notAvailable(false)}`;
}

/** `outline` is the figure-free text of the open report (F8), or '' / absent when none is open. It rides in the per-turn preamble only, never in the cached system or tools. */
export function buildPreamble(data: MetricData, now: Date, outline?: string, exploreCoverage?: string | null, opts: {explore?: boolean; page?: string | null; digests?: string | null; flags?: DataFlags} = {}): string {
  const c = buildCoverage(data);
  const head = `[context] Today is ${longToday(now)} (Philippine time; ${phtDate(now)}).`;
  let cover: string;
  if (c.orders === 0 || c.dataFrom === null || c.dataTo === null) {
    cover = 'There is no order data yet.';
  } else {
    const share = c.untaggedShare === null ? '' : `; ${Math.round(c.untaggedShare)}% have no pet tag`;
    const lead = c.source === 'mock' ? 'The data is sample data, not real sales, and covers' : 'Offline POS data is live and covers';
    cover = `${lead} ${shortDate(c.dataFrom)} to ${shortDate(c.dataTo)} (${c.orders} completed orders${share}).`;
  }
  const base = `${head} ${cover} ${notAvailable(opts.explore === true, opts.flags)} If a question is outside this range, say what the data covers.`;
const withPage = opts.page ? `${base}\n${opts.page}` : base;
  const withDigests = opts.digests ? `${withPage}\n${opts.digests}` : withPage;
  const withCoverage = exploreCoverage ? `${withDigests}\n${exploreCoverage}` : withDigests;
  return outline ? `${withCoverage}\n${outline}` : withCoverage;
}

/** F.5: the stored digest windows, one per-turn line (never in the cached prompt: it changes when a digest lands). Null when none. */
export function digestIndexLine(windows: readonly DigestWindow[], max = 20): string | null {
  if (windows.length === 0) return null;
  const shown = windows.slice(0, max).map(windowLabel).join('; ');
  const more = windows.length > max ? `; and ${windows.length - max} older` : '';
  return `[digests] Stored digest windows, newest first (lengths vary: weekly or about a month): ${shown}${more}. Read one with get_digest window "covering" and the owner's dates, and name the window you used. Total any dates per channel (a month, a custom range, by week or month) with get_channel_report.`;
}

const TOOL_RULES =
  'Tool rules: every tool parameter is required. Use "none", "all" or "default" when a parameter does not apply, and "" for from and to. ' +
  'Pass dates only when range is "custom" (YYYY-MM-DD, Philippine time). Never pass keys that are not in the schema. ' +
  'Every number in an answer must come from a tool result.';

export function buildStaticCatalog(): string {
  const lines: string[] = ['Metric catalog (the only numbers you can query):'];
  for (const id of METRIC_IDS) {
    const m = METRICS[id];
    lines.push(`- ${m.id}: ${m.label}. ${m.description}`);
    lines.push(`  dimensions: ${m.dimensions.map((d) => d.key).join(', ')} (default ${m.defaultDimension})`);
    for (const x of m.measures) lines.push(`  measure ${x.key} [${x.kind}]: ${x.method}`);
    lines.push(`  default measure ${m.defaultMeasure}; pet filter ${m.supportsPet ? 'yes' : 'no'}, event filter ${m.supportsEvent ? 'yes' : 'no'}, compare ${m.supportsCompare ? 'yes' : 'no'}`);
  }
  lines.push(TOOL_RULES);
  return lines.join('\n');
}
