import {describe, expect, it, vi} from 'vitest';
import {logNumberViolation} from '../src/chat/audit';
import {checkNumbers} from '../src/chat/number-check';
import {formatPeso} from '../src/pos-format';
import {BASE} from './support/report-fixtures';
import {EVAL_NOW, standardData} from './support/skill-eval-fixtures';
import {runScripted, type ScriptedCall} from './support/scripted-model';

// F11, Slice 6 criterion 1: "Given an answer with an invented number, then a violation is logged; rounded or formatPeso
// forms pass." The check is pure and log-only (design section 7, Slice 6 #1; src/chat/number-check.ts documents the tolerances).

const values = (answer: string, results: unknown[], context?: string): string[] => checkNumbers(answer, results, {context}).violations.map((v) => v.value);

// A result shaped like the registry's compact payload, fictional figures.
const RESULT = {
  id: 'r1',
  rows: [{pet: 'dog', value: 71050, share_of_tagged: 66.4}, {pet: 'cat', value: 18050.5, share_of_tagged: 16.9}, {pet: 'avg', value: 2367.26, share_of_tagged: null}],
  meta: {rowCount: 1352, share_basis: 'tagged bundle revenue', insights: [{text: 'Dog accounts for 66.4% of tagged bundle revenue, 3.9× cat.'}], checks: [{text: 'Pet totals add up: ₱147,300 vs ₱147,300'}]},
};

describe('checkNumbers: what is a violation', () => {
  it('flags an invented peso amount, with the figure and a short context', () => {
    const out = checkNumbers('Dog bundles brought in ₱88,000 last week.', [RESULT]);
    expect(out.violations).toEqual([{value: '₱88,000', context: 'Dog bundles brought in ₱88,000 last week.'}]);
    expect(out.checked).toBe(1);
  });

  it('flags an invented percentage, ratio and count', () => {
    expect(values('Dog is 71.2% of tagged revenue.', [RESULT])).toEqual(['71.2%']);
    expect(values('That is 4.2× cat.', [RESULT])).toEqual(['4.2×']);
    expect(values('There were 1,353 rows.', [RESULT])).toEqual(['1,353']);
    expect(values('Average was ₱2,367.27.', [RESULT])).toEqual(['₱2,367.27']);
  });

  it('lists the same displayed figure once', () => {
    expect(values('₱88,000 here and ₱88,000 again, and ₱91,000.', [RESULT])).toEqual(['₱88,000', '₱91,000']);
  });

  it('treats results that are JSON text like parsed results, and reads numbers inside strings', () => {
    expect(values('Total ₱147,300 and ₱71,050.', [JSON.stringify(RESULT)])).toEqual([]);
    expect(values('Total ₱147,301.', [JSON.stringify(RESULT)])).toEqual(['₱147,301']);
  });

  it('checks nothing when the answer has no figures', () => {
    expect(checkNumbers('Dog leads, cat follows. Ask me about last week next.', [RESULT])).toEqual({checked: 0, violations: []});
    expect(checkNumbers('', [])).toEqual({checked: 0, violations: []});
  });
});

describe('checkNumbers: forms that pass (the documented tolerances)', () => {
  it('exact figures, and formatPeso renderings of any result number', () => {
    for (const n of [71050, 18050.5, 2367.26, 147300]) expect(values(`It was ${formatPeso(n)}.`, [RESULT]), String(n)).toEqual([]);
    expect(values('Rows: 1,352. Share: 66.4%. Ratio: 3.9×.', [RESULT])).toEqual([]);
  });

  it('a rounded form within the shown precision passes; one more digit of precision than the source does not', () => {
    expect(values('About ₱71,050 and ₱18,051 and ₱2,367.', [RESULT])).toEqual([]); // 18050.5 rounds to 18051, 2367.26 to 2367
    expect(values('Dog is 66% and cat 17%.', [RESULT])).toEqual([]);
    expect(values('Average ₱2,367.3.', [RESULT])).toEqual([]);
    expect(values('Dog is 66.5% of it.', [RESULT])).toEqual(['66.5%']);
    expect(values('Cat made ₱18,052.', [RESULT])).toEqual(['₱18,052']);
  });

  it('a truncated form passes too', () => {
    expect(values('Cat made ₱18,050.', [RESULT])).toEqual([]);
  });

  it('k and M suffixes are checked at their own precision', () => {
    expect(values('Roughly ₱71k from dog and ₱147.3k overall.', [RESULT])).toEqual([]);
    expect(values('Roughly ₱90k.', [RESULT])).toEqual(['₱90k']);
  });

  it('the sign is ignored and a share held as a fraction still matches a percentage', () => {
    expect(values('Down 12.9% on the week.', [{delta_pct: -12.88}])).toEqual([]);
    expect(values('Dog is 66.4% of it.', [{share: 0.664}])).toEqual([]);
  });

  it('numbers quoted inside check and insight texts count as present', () => {
    expect(values('Pet totals add up to ₱147,300 and dog is 3.9× cat.', [RESULT])).toEqual([]);
  });
});

describe('checkNumbers: what is never a claim', () => {
  const nothing = (answer: string) => expect(values(answer, [RESULT]), answer).toEqual([]);

  it('dates, ranges, times, years and ordinals', () => {
    nothing('From Sep 11 to Sep 27, 2026, and on 2026-09-27.');
    nothing('From 11 to 27 September 2026, then 9/27 at 10:30 am.');
    nothing('The 21st was busy; in 2026 we grew.');
    nothing('September 2026 and Sept. 5th.');
  });

  it('single digits, number words, list numbering, ids and units', () => {
    nothing('I found three events and 5 SKUs, 3 of them cats.');
    nothing('1. Dog first\n2. Cat second\n10. Both');
    nothing('See block b12 from result r27, order #1042 and SKU 12.');
    nothing('The 80g pack and a 5kg bag.');
    nothing('There were ₱0 pick lines.');
  });

  it('the hidden <go> and <suggest> lines', () => {
    nothing('Answer.<go>Open Sales|/?channel=all</go><suggest>What were the top 25 products? | How did week 38 go?</suggest>');
  });

  it('figures the user asked about, in the question or earlier turns, are not new claims', () => {
    expect(values('No, not ₱5,000: it was ₱71,050.', [RESULT], 'Did we sell ₱5,000 of dog bundles?')).toEqual([]);
    expect(values('Not ₱5,000.', [RESULT])).toEqual(['₱5,000']);
    expect(values('The top 25 are below.', [RESULT], 'Show me the top 25')).toEqual([]);
  });
});

// ---- wired into the loop: log-only ------------------------------------------------------------------------------------------

const QUERY_TOP: ScriptedCall = {name: 'query_metric', input: {...BASE, metric: 'top_products', dimension: 'none', range: 'last_week', limit: 5}};
const ask = (script: Parameters<typeof runScripted>[0]['script'], over: Partial<Parameters<typeof runScripted>[0]> = {}) =>
  runScripted({script, messages: [{role: 'user', content: 'What are our top products last week?'}], data: standardData(), now: EVAL_NOW, ...over});
const violationLines = (r: {info: Record<string, unknown>[]}) => r.info.filter((l) => l.event === 'chat_number_violation');

describe('the loop hook (log-only)', () => {
  it('logs one chat_number_violation line for an invented figure: counts and the figure only, never the answer', async () => {
    const answer = 'Salmon Skin Chips led with ₱99,999 and 4,242 units, an extra sentence nobody should find in the log.';
    const r = await ask([{calls: [QUERY_TOP]}, {text: answer}]);
    const lines = violationLines(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({event: 'chat_number_violation', count: 2, checked: 2, figures: ['₱99,999', '4,242'], user: 'scripted'});
    expect(JSON.stringify(r.info)).not.toContain('extra sentence');
    expect(JSON.stringify(r.info)).not.toContain('Salmon');
    expect(r.errors).toEqual([]); // not an incident
  });

  it('never alters or blocks the answer: the same text streams, the turn ends normally', async () => {
    const answer = 'Chips led with ₱99,999.';
    const r = await ask([{calls: [QUERY_TOP]}, {text: answer}]);
    expect(violationLines(r)).toHaveLength(1);
    expect(r.text).toBe(answer);
    expect(r.events.filter((e) => e.t === 'text')).toEqual([{t: 'text', d: answer}]);
    expect(r.events.at(-1)).toMatchObject({t: 'done', steps: 2});
    expect(r.summary.stopReason).toBe('end_turn');
    expect(r.info.some((l) => l.event === 'chat_turn')).toBe(true);
  });

  it('rounded and formatPeso forms of real result figures pass: no violation line for a clean answer', async () => {
    const r = await ask([
      {calls: [QUERY_TOP]},
      {
        text: (seen) => {
          const rows = (seen[0].content as {rows: {product: string; revenue: number; share: number}[]}).rows;
          const top = rows[0];
          return `${top.product} led with ${formatPeso(top.revenue)} (about ₱${Math.round(top.revenue / 100) * 100 / 1000}k), ${Math.round(top.share)}% of itemized revenue.`;
        },
      },
    ]);
    expect(r.text).toMatch(/₱4,200/);
    expect(violationLines(r)).toEqual([]);
    expect(r.info.map((l) => l.event)).toEqual(['chat_tool', 'chat_turn']);
  });

  it('figures in the user question and in the preamble are not violations', async () => {
    const r = await runScripted({
      script: [{calls: [QUERY_TOP]}, {text: 'You asked about ₱5,000, and there are 59 completed orders in the data.'}],
      messages: [{role: 'user', content: 'Did the top product pass ₱5,000?'}], data: standardData(), preamble: '[context] Offline POS data covers Sep 7 to Sep 27 (59 completed orders).',
    });
    expect(violationLines(r)).toEqual([]);
  });

  it('the selected-period digest block is a source, the skill text in the system prompt is not', async () => {
    const system = [
      {type: 'text' as const, text: 'Skill example: dog bundles ₱106,950, a 23.3% discount.'},
      {type: 'text' as const, text: '## Selected period: week of Sep 21\n```json\n{"comparison":{"lazada":{"revenue":26250.5}}}\n```'},
    ];
    const r = await ask([{text: 'Lazada made ₱26,250.50, not ₱106,950, and the discount was 23.3%.'}], {system});
    const lines = violationLines(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({figures: ['₱106,950', '23.3%']});
  });

  it('error results do not count as a source (their allowed-value lists are not data)', async () => {
    const bad: ScriptedCall = {name: 'query_metric', input: {...QUERY_TOP.input as object, limit: 7}};
    const r = await ask([{calls: [bad]}, {text: 'That is ₱25.'}]);
    expect(r.results[0].is_error).toBe(true);
    expect(violationLines(r)).toHaveLength(1);
  });

  it('a throwing check cannot break the turn', async () => {
    vi.resetModules();
    vi.doMock('../src/chat/number-check', () => ({checkNumbers: () => { throw new Error('boom'); }}));
    const {runChatLoop} = await import('../src/chat/loop');
    const {ScriptedClient} = await import('./support/scripted-model');
    const events: {t: string}[] = [];
    await runChatLoop({
      client: new ScriptedClient([{text: 'Fine ₱99.'}]), model: 'm', maxTokens: 10, effort: 'low', system: [{type: 'text', text: 'S'}], tools: [], messages: [{role: 'user', content: 'hi'}],
      preamble: 'p', executors: {}, emit: (e) => events.push(e), user: null, sink: {info: vi.fn(), error: vi.fn()},
    });
    vi.doUnmock('../src/chat/number-check');
    expect(events.map((e) => e.t)).toEqual(['text', 'done']);
  });
});

describe('logNumberViolation', () => {
  it('caps the figures at ten and scrubs each', () => {
    const sink = {info: vi.fn(), error: vi.fn()};
    const violations = Array.from({length: 14}, (_, i) => ({value: `₱${i + 100}`}));
    logNumberViolation({violations, checked: 20, user: 'a@b.c'}, sink);
    const line = JSON.parse(sink.info.mock.calls[0][0] as string);
    expect(line).toMatchObject({event: 'chat_number_violation', count: 14, checked: 20, user: 'a@b.c'});
    expect(line.figures).toHaveLength(10);
    expect(sink.error).not.toHaveBeenCalled();
  });
});

// GAP-06 (review minor m4): the check matches a displayed figure against ANY number anywhere in the results, whatever its column or
// kind (checkNumbers documents this under KNOWN LIMITS). So an invented figure that happens to equal an unrelated source number
// passes. The target behaviour is a violation: these three are written as that target and marked `it.fails`, so today they document
// the false negative and the suite turns red the day the check is tightened (then remove `.fails`). The control proves the figures
// below are checked at all.
describe('checkNumbers: known false negatives (target is a violation; remove .fails when the check matches by column or kind)', () => {
  const UNITS = [{rows: [{units: 12, revenue: 4800}]}];

  it('control: a figure that is in no result IS flagged', () => {
    expect(values('There were 13 orders.', UNITS)).toEqual(['13']);
  });

  it.fails('an order count that equals the units sold (a different quantity) is a violation', () => {
    expect(values('There were 12 orders.', UNITS)).toEqual(['12']);
  });

  it.fails('a percentage that equals an unrelated number (12 units is not 12%) is a violation', () => {
    expect(values('That is 12% of sales.', UNITS)).toEqual(['12%']);
  });

  it.fails('a peso amount that equals a count (12 units is not ₱12) is a violation', () => {
    expect(values('Sales were ₱12.', UNITS)).toEqual(['₱12']);
  });
});

// Live test 4 (G01): "6 orders at Circuit Makati Weekend" was 5 + 2 added in the model's head (the true figure was 7). Single digits were exempt.
describe('checkNumbers countNouns (Explore enforce mode): a single digit before a count noun must be a cell', () => {
  const rows = [{result: {rows: [{event: 'Circuit Makati Weekend', orders_count: 5}, {event: 'circuit makati weekend', orders_count: 2}]}}];
  const check = (t: string, on = true) => checkNumbers(t, rows, {countNouns: on}).violations.map((v) => v.value);
  it('flags "6 orders" when the rows hold 5 and 2 and no 6 or 7', () => {
    expect(check('6 orders at Circuit Makati Weekend.')).toEqual(['6']);
  });
  it('also flags a typed per-event total that is no cell ("7 orders")', () => {
    expect(check('7 orders at SM Aura.')).toEqual(['7']);
  });
  it('passes "7 orders" when a cell holds 7, and "5 orders" / "2 leads" that are cells', () => {
    expect(checkNumbers('7 orders at Circuit Makati Weekend.', [{rows: [{orders_count: 7}]}], {countNouns: true}).violations).toEqual([]);
    expect(check('5 orders under one spelling and 2 orders under the other.')).toEqual([]);
    expect(check('2 leads.')).toEqual([]);
  });
  it('does not flag "2 spellings" or "3 notes" (not count nouns), nor number words', () => {
    expect(check('The event has 2 spellings and 3 notes; six orders.')).toEqual([]);
  });
  it('covers every listed noun, plural or singular', () => {
    for (const n of ['order', 'orders', 'lead', 'leads', 'sign-up', 'sign-ups', 'signup', 'event', 'events', 'customer', 'customers', 'unit', 'units', 'item', 'items', 'pack', 'packs', 'bundle', 'bundles']) {
      expect(check(`8 ${n} here`), n).toEqual(['8']);
    }
  });
  it('is off by default: registry and non-Explore behaviour is unchanged', () => {
    expect(check('6 orders at Circuit Makati Weekend.', false)).toEqual([]);
    expect(checkNumbers('6 orders', rows).violations).toEqual([]);
  });
  it('a digit the question already gave is not a new claim', () => {
    expect(checkNumbers('3 orders', rows, {countNouns: true, context: 'show me the top 3 orders'}).violations).toEqual([]);
  });
});

// The calculation guardrail (2026-10-22): the model may add, compare and average figures from this turn's tool results, showing the working.
// A figure that is in no tool result is `derived` (not a violation) only when it equals arithmetic over OTHER figures of the same answer
// that are themselves grounded. Operands must be shown in the answer: a check over every tool-result number would accept coincidences.
describe('checkNumbers: derived figures (the model calculates and shows the working)', () => {
  const SALES = [{rows: [{channel: 'shopee', revenue: 59228}, {channel: 'lazada', revenue: 11222}, {channel: 'website', revenue: 51989}, {pet: 'dog', value: 71050}, {pet: 'cat', value: 18050.5}]}];
  const check = (text: string, results: unknown[] = SALES) => checkNumbers(text, results);

  it('a true sum of two grounded figures shown in the answer is derived, not a violation', () => {
    const out = check('Online total: ₱59,228 + ₱11,222 = ₱70,450, calculated.');
    expect(out.violations).toEqual([]);
    expect(out.derived).toEqual([{value: '₱70,450', op: 'sum', operands: ['₱59,228', '₱11,222']}]);
  });

  it('a wrong sum stays a violation', () => {
    expect(values('Online total: ₱59,228 + ₱11,222 = ₱70,451, calculated.', SALES)).toEqual(['₱70,451']);
    expect(check('Online total: ₱59,228 + ₱11,222 = ₱70,451.').derived).toBeUndefined();
  });

  it('a total without its working is a violation (the operands must be shown in the answer)', () => {
    expect(values('The online total is ₱70,450.', SALES)).toEqual(['₱70,450']);
  });

  it('a difference, an average and a three-way sum verify', () => {
    expect(check('Shopee ₱59,228 vs website ₱51,989: ₱7,239 more, calculated.').violations).toEqual([]);
    expect(check('Shopee ₱59,228 and lazada ₱11,222 average ₱35,225, calculated.').derived?.[0]?.op).toBe('average');
    expect(check('₱59,228 + ₱11,222 + ₱51,989 = ₱122,439, calculated.').derived?.[0]).toMatchObject({op: 'sum', operands: ['₱59,228', '₱11,222', '₱51,989']});
  });

  it('a percent change, a ratio and a share verify', () => {
    expect(check('Shopee ₱59,228 against ₱51,989 is up 13.9%, calculated.').derived?.[0]).toMatchObject({value: '13.9%', op: 'percent_change'});
    expect(check('Dog ₱71,050 is 3.9× cat ₱18,051, calculated.').derived?.[0]).toMatchObject({value: '3.9×', op: 'ratio'});
    const withTotal = [{rows: [{channel: 'shopee', revenue: 59228}, {channel: 'online_total', revenue: 70450}]}];
    expect(check('Shopee ₱59,228 of ₱70,450 is 84.1%, calculated.', withTotal).derived?.[0]).toMatchObject({value: '84.1%', op: 'share'});
  });

  it('a derived total can feed a derived share (two rounds)', () => {
    const out = check('₱59,228 + ₱11,222 = ₱70,450, so Shopee is 84.1% of it, calculated.');
    expect(out.violations).toEqual([]);
    expect(out.derived?.map((d) => d.value)).toEqual(['₱70,450', '84.1%']);
  });

  it('operands of a different kind do not make a sum (pesos are not counts)', () => {
    expect(values('₱59,228 and ₱11,222 give 70,450 orders.', SALES)).toEqual(['70,450']);
  });

  it('a figure that cannot be derived stays a violation, as before', () => {
    expect(values('Shopee ₱59,228 and lazada ₱11,222 give ₱88,000.', SALES)).toEqual(['₱88,000']);
  });

  it('the search is capped: only the first 12 same-kind figures are operands', () => {
    const vals = Array.from({length: 13}, (_, i) => 10 * 2 ** (i + 1)); // 20, 40, ... : every subset sum differs
    const res = [{rows: vals.map((v) => ({v}))}];
    const show = (v: number) => `₱${v.toLocaleString('en-US')}`;
    const list = vals.map(show).join(', ');
    // The working must be in the same sentence as its operands, so the list and the result share one sentence here.
    const f12and13 = `${list}, the last two add to ${show(vals[11] + vals[12])}, calculated.`;
    expect(values(f12and13, res)).toEqual([show(vals[11] + vals[12])]); // the 13th figure is past the cap
    const f1and2 = `${list}, the first two add to ${show(vals[0] + vals[1])}, calculated.`;
    expect(values(f1and2, res)).toEqual([]);
  });

  it('the result keeps its old shape when nothing is derived (no derived key)', () => {
    expect(check('Dog bundles brought in ₱88,000 last week.')).toEqual({checked: 1, violations: [{value: '₱88,000', context: 'Dog bundles brought in ₱88,000 last week.'}]});
  });
});

// Review finding B1 (2026-10-22): a wrong figure must not be blessed because it happens to equal some subset sum or ratio of the other figures
// in the answer. A derivation counts only when its working (result, operands and an operator or "calculated") is in ONE sentence.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('checkNumbers: coincidences are not derivations (the working must be in the answer)', () => {
  it('a wrong seventh order count is never blessed when no working is shown (deterministic replay of the reviewer measurement)', () => {
    const rand = mulberry32(20261022);
    let blessed = 0;
    let trials = 0;
    for (let n = 0; n < 400; n += 1) {
      const counts = new Set<number>();
      while (counts.size < 6) counts.add(20 + Math.floor(rand() * 80)); // six order counts of 20 to 99, all in the tool result
      const wrong = 20 + Math.floor(rand() * 400);
      if (counts.has(wrong)) continue;
      trials += 1;
      const text = `${[...counts].map((c) => `${c} orders`).join(', ')} and ${wrong} orders in total.`;
      const out = checkNumbers(text, [{rows: [...counts].map((c) => ({orders: c}))}]);
      if (!out.violations.some((v) => v.value === String(wrong))) blessed += 1;
    }
    expect(trials).toBeGreaterThan(300);
    expect(blessed).toBe(0);
  });

  it('a wrong "up N%" is never blessed beside peso figures when no working is shown', () => {
    const rand = mulberry32(7);
    let blessed = 0;
    let trials = 0;
    for (let n = 0; n < 300; n += 1) {
      const pesos = [0, 1, 2, 3].map(() => 10000 + Math.floor(rand() * 90000));
      const wrong = 5 + Math.floor(rand() * 200);
      trials += 1;
      const text = `${pesos.map((p) => `₱${p.toLocaleString('en-US')}`).join(', ')} and sales were up ${wrong}%.`;
      const out = checkNumbers(text, [{rows: pesos.map((p) => ({revenue: p}))}]);
      if (!out.violations.some((v) => v.value === `${wrong}%`)) blessed += 1;
    }
    expect(trials).toBe(300);
    expect(blessed).toBe(0);
  });

  it('the same counts WITH their working in one sentence still verify', () => {
    const out = checkNumbers('Orders: 72 + 31 = 103 orders, calculated.', [{rows: [{orders: 72}, {orders: 31}]}]);
    expect(out.violations).toEqual([]);
    expect(out.derived?.[0]).toMatchObject({value: '103', op: 'sum', operands: ['72', '31']});
  });

  it('a correct percent change with its working verifies; the bare percent in another sentence does not', () => {
    const res = [{rows: [{revenue: 51989}, {revenue: 59228}]}];
    expect(checkNumbers('₱59,228 against ₱51,989 is up 13.9%, calculated.', res).violations).toEqual([]);
    expect(checkNumbers('Sales were ₱59,228 and ₱51,989. They are up 13.9%.', res).violations.map((v) => v.value)).toEqual(['13.9%']);
  });

  it('the operands and the result in different sentences are not a working, even with the word calculated elsewhere', () => {
    const res = [{rows: [{revenue: 59228}, {revenue: 11222}]}];
    expect(checkNumbers('Shopee ₱59,228 and Lazada ₱11,222. The total is ₱70,450, calculated.', res).violations.map((v) => v.value)).toEqual(['₱70,450']);
  });

  it('a count or percent sum needs an explicit operator or "calculated"; a peso sum may say "total of"', () => {
    const counts = [{rows: [{orders: 72}, {orders: 31}]}];
    expect(checkNumbers('The total of 72 and 31 is 103 orders.', counts).violations.map((v) => v.value)).toEqual(['103']);
    const pesos = [{rows: [{revenue: 59228}, {revenue: 11222}]}];
    expect(checkNumbers('The total of ₱59,228 and ₱11,222 is ₱70,450.', pesos).violations).toEqual([]);
  });

  it('a ratio figure such as 3.9x is not itself an operator', () => {
    expect(checkNumbers('Dog ₱71,050 and cat ₱18,051 are 3.9x.', [{rows: [{v: 71050}, {v: 18051}]}]).violations.map((v) => v.value)).toEqual(['3.9x']);
  });

  it('an average of percents is not blessed, and neither is a share or change of two percents (quote the tool row for AOV, ROAS, ACOS)', () => {
    // A peso average of two AOVs cannot be told from any peso average here: the prompt rule ("never add or average AOV, ROAS, ACOS or percentages") is that guard.
    const pct = [{rows: [{share: 40}, {share: 60}]}];
    expect(checkNumbers('Shares 40% and 60% average 50%, calculated.', pct).violations.map((v) => v.value)).toEqual(['50%']);
    expect(checkNumbers('Shares 40% and 60% give 66.7%, calculated.', pct).violations.map((v) => v.value)).toEqual(['66.7%']);
  });

  it('a figure repeated in the answer is one operand: 100 + 100 is not derived from a repeated mention', () => {
    const res = [{rows: [{revenue: 100}]}];
    expect(checkNumbers('Shopee ₱100 and again ₱100 give ₱200, calculated.', res).violations.map((v) => v.value)).toEqual(['₱200']);
  });

  it('a later mention of an already derived figure is derived too', () => {
    const res = [{rows: [{revenue: 59228}, {revenue: 11222}]}];
    const out = checkNumbers('₱59,228 + ₱11,222 = ₱70,450, calculated. So the online total is ₱70,450.', res);
    expect(out.violations).toEqual([]);
    expect(out.derived?.map((d) => d.value)).toEqual(['₱70,450']);
  });

  it('a wrong sum with its working in the sentence stays unmatched', () => {
    const res = [{rows: [{revenue: 59228}, {revenue: 11222}]}];
    expect(checkNumbers('₱59,228 + ₱11,222 = ₱70,451, calculated.', res).violations.map((v) => v.value)).toEqual(['₱70,451']);
  });
});

