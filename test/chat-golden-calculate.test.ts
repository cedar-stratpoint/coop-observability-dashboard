import {describe, expect, it} from 'vitest';
import {checkNumbers} from '../src/chat/number-check';
import {dedupeReruns, sameWindow, windowOf} from '../src/digest-windows';
import type {DigestSource} from '../src/chat/digest-lookup';
import {goldenData} from './support/golden-cases';
import {runScripted, type Script} from './support/scripted-model';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

// Scripted golden cases for "Ask Coop can add and compare figures honestly" (plan: knowledge/tasks/2026-10-22-ask-coop-guardrails-loosening-plan.md).
// A fake model drives the REAL loop and the REAL get_channel_report executor over a synthetic September (FICTIONAL numbers); each final answer is
// the one a model following the loosened guardrail should write. The numbers in the answers are checked by the REAL verifier (checkNumbers).

const NOW = new Date('2026-10-07T04:00:00Z');
const sept = (): DigestSource => ({
  source: 'live', rows: SEPTEMBER_ROWS.slice(0, 2), index: dedupeReruns(SEPTEMBER_ROWS.map(windowOf), (w) => w),
  rowAt: async (w) => SEPTEMBER_ROWS.find((r) => sameWindow(windowOf(r), w)) ?? null,
});
const ASK = {from: '2026-09-01', to: '2026-09-30', channels: ['all'], granularity: 'total'};
// One website order of ₱1,000 (2 units) on 30 Sep PH, so the Website channel is connected and complete for the month.
const WEBSITE = async () => ({orders: [{createdAt: '2026-09-30T15:59:00Z', totalPrice: '1000', lineItems: JSON.stringify([{title: 'A', quantity: 2, price: 500}])}] as never, asOf: '2026-10-07T04:00:00Z'});

type Totals = {label: string; status: 'complete' | 'partial'; channels_included: string[]; channels_excluded: {channel: string; reason: string}[]; revenue: number | null; calculated_in_code: boolean; note: string};
type Report = {rows: {channel: string; revenue: number | null}[]; meta: {totals: Totals[]}};

/** Step 1 asks for the report, step 2 is the final answer (a function of what the tool returned). */
async function ask(question: string, answer: (r: Report) => string, opts: {website?: boolean} = {}) {
  const script: Script = [
    {calls: [{name: 'get_channel_report', input: ASK}]},
    {text: (seen) => answer(seen[0].content as Report)},
  ];
  const run = await runScripted({script, messages: [{role: 'user', content: question}], data: goldenData(), now: NOW, digest: sept(), ...(opts.website ? {crmOrders: WEBSITE} : {})});
  const report = run.results[0].content as Report;
  const answerText = run.text;
  const check = checkNumbers(answerText, run.results.map((r) => r.content), {context: question});
  return {run, report, answerText, check};
}
const peso = (n: number) => `₱${n.toLocaleString('en-US')}`;
const total = (r: Report, label: string) => r.meta.totals.find((t) => t.label === label)!;
const row = (r: Report, channel: string) => r.rows.find((x) => x.channel === channel)!;

describe('golden: totals come from the code, the model quotes them', () => {
  it('1. "give me the total across channels for September": quotes the code total, and says the all-channel total is partial', async () => {
    const {run, report, answerText, check} = await ask(
      'Give me the total across channels for September',
      (r) => `Online total (Shopee, Lazada and Website): ${peso(total(r, 'Online total').revenue!)}, calculated in code. The all-channel total is partial: Offline only covers part of September, so I left it out.`,
      {website: true},
    );
    expect(run.summary.steps).toBe(2);
    expect(run.errors).toEqual([]);
    const online = total(report, 'Online total');
    const all = total(report, 'All channels');
    expect(online).toMatchObject({status: 'complete', channels_included: ['Shopee', 'Lazada', 'Website'], calculated_in_code: true});
    expect(online.revenue).toBe(73200);
    expect(online.note).toContain(`${peso(online.revenue!)} revenue from`); // the total's own sentence carries the revenue
    expect(all.status).toBe('partial');
    expect(all.channels_excluded.map((c) => c.channel)).toEqual(['Offline']);
    // whole centavos: the total equals the sum of the three rows to the centavo, with no float drift
    const centavos = ['Shopee', 'Lazada', 'Website'].reduce((s, c) => s + Math.round(row(report, c).revenue! * 100), 0);
    expect(Math.round(online.revenue! * 100)).toBe(centavos);
    expect(answerText).toContain('₱73,200');
    expect(answerText).toMatch(/partial/);
    expect(answerText).toMatch(/Offline/);
    expect(check.violations).toEqual([]);
  });

  it('2. a partial total: Website is not connected, the answer says partial and names it', async () => {
    const {report, answerText, check} = await ask(
      'How much did we sell online in September in total?',
      (r) => `This is a partial total: ${peso(total(r, 'Online total').revenue!)} for Shopee and Lazada only. Website is not connected, so it is not in it.`,
    );
    const online = total(report, 'Online total');
    expect(online.status).toBe('partial');
    expect(online.channels_excluded).toEqual([{channel: 'Website', reason: 'is not connected'}]);
    expect(online.revenue).toBe(72200);
    expect(online.note).toContain(`${peso(online.revenue!)} revenue from`);
    expect(answerText).toContain(peso(online.revenue!)); // and the answer states it
    expect(online.note).toMatch(/Left out: Website is not connected/);
    expect(answerText).toMatch(/partial total/);
    expect(answerText).toMatch(/Website/);
    expect(check.violations).toEqual([]);
  });
});

describe('golden: the model may calculate over this turn\'s figures, with the working shown', () => {
  it('3. "how much more did Lazada sell than Shopee": the difference is derived and verified', async () => {
    const {report, answerText, check} = await ask(
      'How much more did Lazada sell than Shopee in September?',
      (r) => `Lazada sold ${peso(row(r, 'Lazada').revenue! - row(r, 'Shopee').revenue!)} more: ${peso(row(r, 'Lazada').revenue!)} - ${peso(row(r, 'Shopee').revenue!)} = ${peso(row(r, 'Lazada').revenue! - row(r, 'Shopee').revenue!)}, calculated.`,
    );
    expect(row(report, 'Lazada').revenue).toBe(42400);
    expect(row(report, 'Shopee').revenue).toBe(29800);
    expect(answerText).toContain('₱42,400 - ₱29,800 = ₱12,600, calculated');
    expect(check.violations).toEqual([]);
    expect(check.derived?.map((d) => d.value)).toContain('₱12,600');
    expect(check.derived?.find((d) => d.value === '₱12,600')).toMatchObject({op: 'difference', operands: ['₱42,400', '₱29,800']});
  });

  it('4. "what share of online is Shopee": the percent is derived from two tool figures, working shown', async () => {
    const {answerText, check} = await ask(
      'What share of online sales is Shopee?',
      (r) => {
        const shopee = row(r, 'Shopee').revenue!;
        const online = total(r, 'Online total').revenue!;
        return `Shopee is ${(Math.round((shopee / online) * 1000) / 10).toFixed(1)}% of online: ${peso(shopee)} / ${peso(online)} = ${(Math.round((shopee / online) * 1000) / 10).toFixed(1)}%, calculated.`;
      },
      {website: true},
    );
    expect(answerText).toContain('₱29,800 / ₱73,200 = 40.7%, calculated');
    expect(check.violations).toEqual([]);
    expect(check.derived?.find((d) => d.value === '40.7%')).toMatchObject({op: 'share'});
  });

  it('5. a WRONG calculation stays unmatched (the verifier still catches it) and the loop never blocks', async () => {
    const {run, answerText, check} = await ask(
      'Add Shopee and Lazada for September',
      (r) => `${peso(row(r, 'Shopee').revenue!)} + ${peso(row(r, 'Lazada').revenue!)} = ₱75,000, calculated.`, // the true sum is ₱72,200
    );
    expect(check.violations.map((v) => v.value)).toEqual(['₱75,000']);
    expect(check.derived?.map((d) => d.value) ?? []).not.toContain('₱75,000');
    // log-only: the answer was delivered as written, the turn finished normally
    expect(answerText).toContain('₱75,000');
    expect(run.summary.steps).toBe(2);
    expect(run.events.at(-1)).toMatchObject({t: 'done'});
    expect(run.errors).toEqual([]);
  });
});

describe('golden: the harness is honest', () => {
  it('6. a script that runs out of steps FAILS the turn instead of being padded', async () => {
    // The model asks for a tool and the script has no second step to answer with: the real loop asks for step 2, the scripted model throws, and
    // the loop turns that into an error event. A padded script would hide an unexpected extra model call; this proves it is loud.
    const script: Script = [{calls: [{name: 'get_channel_report', input: ASK}]}];
    const run = await runScripted({script, messages: [{role: 'user', content: 'total please'}], data: goldenData(), now: NOW, digest: sept()});
    expect(run.client.requests).toHaveLength(2); // the loop did ask for the second step
    expect(run.events.some((e) => e.t === 'error')).toBe(true);
    expect(run.events.some((e) => e.t === 'done')).toBe(false);
    expect(run.errors.map((e) => e.event)).toContain('chat_error');
    expect(run.text).toBe(''); // no answer was produced
  });
});
