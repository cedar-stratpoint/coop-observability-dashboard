// The data part of Ask Coop's CACHED system prompt, built from the runtime catalog (spec 2b.1, 2b.2). Pure and deterministic:
// no dates, counts or values, so the prompt cache holds. Closed names (secret or tenant) never appear.
import {isClosedRelation} from '../explore/secret-names';
import {CATALOG_DATA} from './index';

/** The tables whose columns stay in the cached prompt, to save describe_table round trips (spec 2.3). */
export const PROMPT_TABLES: readonly string[] = ['pos_orders_completed', 'pos_orders', 'pos_order_items', 'pos_products', 'pos_events', 'pos_inventory_by_location', 'pos_stock_movements', 'spin_wheel_leads', 'digest_archive', 'coop_reports'];

export function buildDataIndexText(): string {
  const lines = [
    '## Data you can read (run_query)',
    'Every table and view in the database is readable by its own name, except secrets and data that belongs to another business. Domains and tables:',
  ];
  for (const d of CATALOG_DATA.domains) {
    const open = d.tables.filter((t) => !isClosedRelation(t));
    if (open.length > 0) lines.push(`- ${d.id} (${d.title}): ${open.join(', ')}`);
  }
  lines.push('', 'Most-used tables:');
  for (const name of PROMPT_TABLES) {
    const t = CATALOG_DATA.tables[name];
    if (!t || isClosedRelation(name)) continue;
    const test = t.testOrders && !/^unknown/i.test(t.testOrders) ? ` Test orders: ${t.testOrders}` : ''; // an unknown marker is a dev note, not a fact for the model
    lines.push(`- ${name}: ${t.about}${t.prefer ? ` Prefer: ${t.prefer}` : ''}${test}`);
    if (t.columns) lines.push(`  columns: ${t.columns}`);
  }
  lines.push('', 'Defaults for ambiguous words. If the page or the question settles the meaning, use it; otherwise use the default, say it, and offer the alternative in one line:');
  for (const t of CATALOG_DATA.terms) lines.push(`- ${t.term}: default ${t.default}; alternatives ${t.alternatives}; ask first when ${t.askWhen}`);
  lines.push('', 'list_tables shows every readable table; describe_table shows the columns of any table.');
  return lines.join('\n');
}

/**
 * Which optional Ask Coop data sources are switched on. `website`: get_channel_report reads live website (CRM) orders (Train 3, when
 * the CRM is configured). `crm`: the CRM list tools are on (Train 4). A flag only changes its source's entry in the gap line.
 */
export interface DataFlags {website?: boolean; crm?: boolean}

/** The flag that makes an API fully readable (it leaves the gap line). */
const FLAG_FOR_API: Record<string, keyof DataFlags> = {'crm-api': 'crm'};
/** A flag that makes part of an API readable: the gap line names what is readable and what is not yet. */
const PARTIAL_FOR_API: Record<string, {flag: keyof DataFlags; text: string}> = {
  'crm-api': {flag: 'website', text: 'website order totals for any dates through get_channel_report; customers, carts and order lists not readable by Ask Coop yet'},
};
const NOT_YET = 'an API, not readable by Ask Coop yet';

/** The honest-gap line (spec 2b.1, 2.7): data that is not in the database, where it lives and why the chat cannot read it. */
export function notInDatabaseText(flags: DataFlags = {}): string {
  const gaps = CATALOG_DATA.apis
    .filter((a) => /^none/i.test(a.askCoop) || (FLAG_FOR_API[a.id] !== undefined && !flags[FLAG_FOR_API[a.id]]))
    .map((a) => {
      if (/^none/i.test(a.askCoop)) return `${a.source} (${a.askCoop.replace(/^none:?\s*/i, '')})`;
      const partial = PARTIAL_FOR_API[a.id];
      return `${a.source} (${partial && flags[partial.flag] ? partial.text : NOT_YET})`;
    });
  return `Not in the database: ${gaps.join('; ')}.`;
}
