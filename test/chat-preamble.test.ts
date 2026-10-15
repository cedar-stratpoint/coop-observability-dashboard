import {describe, it, expect} from 'vitest';
import {buildDegradedPreamble, buildPreamble, buildStaticCatalog, digestIndexLine} from '../src/chat/preamble';
import {METRICS, METRIC_IDS} from '../src/chat/metrics-registry';
import {dedupeReruns, windowOf} from '../src/digest-windows';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';
import type {MetricData} from '../src/chat/result-types';
import type {PosOrder} from '../src/pos-sales-types';

function ord(id: string, at: string, pet: PosOrder['pet_type'] = null): PosOrder {
  return {
    id, client_uuid: id, subtotal: 1234, discount: null, total: 1234, oversold: false, device_id: null, payment_method: 'cash',
    customer_handle: null, status: 'completed', remarks: null, created_at: at, edited_at: null, event_id: null, pet_type: pet, items: [],
  };
}
const data = (over: Partial<MetricData> = {}): MetricData => ({
  source: 'live',
  orders: [ord('a', '2026-09-11T10:00:00+08:00', 'dog'), ord('b', '2026-09-20T10:00:00+08:00'), ord('c', '2026-09-27T10:00:00+08:00', 'cat')],
  events: [], prices: [], priceChanges: [], bulkReads: [], ...over,
});

describe('buildPreamble', () => {
  const now = new Date('2026-10-01T04:00:00Z');

  it('states weekday, date, coverage and the unavailable list', () => {
    const p = buildPreamble(data(), now);
    expect(p).toContain('Thursday, 1 October 2026');
    expect(p).toContain('live and covers 11 Sep 2026 to 27 Sep 2026 (3 completed orders; 33% have no pet tag)');
    expect(p).toMatch(/Traffic.*Meta ads.*Shopee/);
    expect(p).toMatch(/outside this range/);
  });

  it('does not forbid pet and event questions as "customer-level data"', () => {
    const p = buildPreamble(data(), now);
    expect(p).not.toMatch(/customer-level/i);
    expect(p).toMatch(/Pet type and event ARE available/);
    expect(buildDegradedPreamble(now)).not.toMatch(/customer-level/i);
  });

  it('Explore off: says contacts and free-form questions are out of reach', () => {
    const p = buildPreamble(data(), now);
    expect(p).toMatch(/Contact details \(email, phone, instagram\) are not exposed by the metrics/);
    expect(p).toMatch(/Questions no metric covers cannot be answered/);
  });

  it('Explore on: never calls contacts, free-form questions or stock unavailable', () => {
    const p = buildPreamble(data(), now, undefined, 'Explore coverage line', {explore: true});
    expect(p).not.toMatch(/not exposed/i);
    expect(p).not.toMatch(/planned, not available/i);
    expect(p).not.toMatch(/cannot be answered/i);
    expect(p).not.toMatch(/stock[^.]*not available/i);
    expect(p).toMatch(/run_query/);
  });

  it('puts the page line after the base line and before the Explore coverage line', () => {
    const p = buildPreamble(data(), now, undefined, 'Explore coverage line', {explore: true, page: '[page] PAGE LINE'});
    const base = p.indexOf('If a question is outside this range');
    expect(base).toBeGreaterThan(-1);
    expect(p.indexOf('[page] PAGE LINE')).toBeGreaterThan(base);
    expect(p.indexOf('Explore coverage line')).toBeGreaterThan(p.indexOf('[page] PAGE LINE'));
  });

  it('is deterministic', () => {
    expect(buildPreamble(data(), now)).toBe(buildPreamble(data(), now));
  });

  it('uses PHT, not the machine timezone, at the day edge', () => {
    expect(buildPreamble(data(), new Date('2026-09-30T17:00:00Z'))).toContain('Thursday, 1 October 2026');
    expect(buildPreamble(data(), new Date('2026-09-30T15:00:00Z'))).toContain('Wednesday, 30 September 2026');
  });

  it('has a mock and an empty variant', () => {
    expect(buildPreamble(data({source: 'mock'}), now)).toMatch(/sample data/);
    const empty = buildPreamble(data({orders: []}), now);
    expect(empty).toMatch(/no order data yet/);
    expect(empty).not.toMatch(/NaN|null|undefined/);
  });

  it('stays short and has no money or other percentages', () => {
    const p = buildPreamble(data(), now);
    expect(p.length).toBeLessThan(1200); // was 600 before the catalog-built "Not in the database" line (measured 1068)
    expect(p).not.toMatch(/₱|PHP|\$/);
    expect(p.match(/\d+%/g)).toEqual(['33%']);
  });
});

describe('buildStaticCatalog', () => {
  const cat = buildStaticCatalog();

  it('is static across calls', () => {
    expect(buildStaticCatalog()).toBe(cat);
  });

  it('mentions every metric id, measure key and method', () => {
    for (const id of METRIC_IDS) {
      expect(cat).toContain(id);
      for (const m of METRICS[id].measures) {
        expect(cat).toContain(`measure ${m.key} `);
        expect(cat).toContain(m.method);
      }
    }
  });

  it('stays under the token cap and has no dates or counts', () => {
    expect(cat.length / 3.5).toBeLessThan(1500);
    expect(cat).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });

  it('contains the tool rules', () => {
    expect(cat).toMatch(/every tool parameter is required/);
    expect(cat).toMatch(/"none", "all" or "default"/);
    expect(cat).toMatch(/custom/);
    expect(cat).toMatch(/must come from a tool result/);
  });
});

describe('buildDegradedPreamble', () => {
  it('gives today in Philippine time and says live POS data is unavailable, with no figures', () => {
    const text = buildDegradedPreamble(new Date('2026-09-30T17:00:00Z')); // 1 Oct 01:00 PHT
    expect(text).toContain('Thursday, 1 October 2026');
    expect(text).toContain('2026-10-01');
    expect(text).toMatch(/Live offline POS data is not available right now/);
    expect(text).not.toMatch(/\d+%|₱|\d+ completed orders/);
    expect(buildDegradedPreamble(new Date('2026-09-30T17:00:00Z'))).toBe(text);
  });
});

describe('F.5 the [digests] line', () => {
  const now = new Date('2026-10-07T04:00:00Z');
  const idx = dedupeReruns(SEPTEMBER_ROWS.map(windowOf), (w) => w);
  it('lists every stored window in PH dates, newest first, re-runs once, exact times when not PH-aligned', () => {
    const line = digestIndexLine(idx) as string;
    expect(line).toContain('[digests] Stored digest windows, newest first (lengths vary: weekly or about a month): Sep 28 to Oct 4, 2026; Sep 21 to Sep 27, 2026; Sep 1 to Sep 27, 2026; Aug 1, 2026 08:00 to Sep 1, 2026 08:00 (PH time); Jul 10, 2026 11:40 to Aug 9, 2026 11:40 (PH time).');
    expect(line).toContain('get_digest window "covering"');
  });
  it('caps the list and is null when nothing is stored', () => {
    expect(digestIndexLine(idx, 2)).toContain('Sep 21 to Sep 27, 2026; and 3 older.');
    expect(digestIndexLine([])).toBeNull();
  });
  it('rides in the per-turn preamble after the page line', () => {
    expect(buildPreamble(data(), now, undefined, null, {page: '[page] x', digests: '[digests] y'})).toMatch(/\[page\] x\n\[digests\] y$/);
  });
});
