import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {LOCAL_HOSTS, assertLocalRun, majority, renderTable, type LiveRun, type RunCase} from '../scripts/chat-eval.mjs';
import {BASE_SPEC, GOLDEN_CASES, GOLDEN_DIGEST, askFirstFailures, goldenData, mechanicalFailures, parseVerdict, rubricPrompt, type GoldenCase} from './support/golden-cases';
import {runScripted, type RunResult} from './support/scripted-model';
import {EVAL_NOW} from './support/skill-eval-fixtures';

async function run(c: GoldenCase): Promise<RunResult> {
  return runScripted({
    script: c.script, messages: [...(c.prior ?? []), {role: 'user', content: c.prompt}], data: goldenData(), now: EVAL_NOW,
    report: c.startReport ?? null, digest: GOLDEN_DIGEST,
  });
}

describe('golden set, offline', () => {
  it('has 29 cases, unique ids, in the documented categories', () => {
    expect(GOLDEN_CASES).toHaveLength(29);
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(29);
    const by = (k: string) => GOLDEN_CASES.filter((c) => c.category === k).length;
    expect({data: by('data'), lookup: by('lookup'), dashboard: by('dashboard'), multiturn: by('multiturn'), negative: by('negative'), ask_first: by('ask_first')}).toEqual({data: 11, lookup: 3, dashboard: 3, multiturn: 4, negative: 5, ask_first: 3});
  });

  it.each(GOLDEN_CASES.map((c) => [c.id, c] as const))('%s: the scripted run meets every mechanical expectation', async (_id, c) => {
    const r = await run(c);
    expect(r.errors, 'no guard trip, no error line').toEqual([]);
    expect(r.events.some((e) => e.t === 'error')).toBe(false);
    expect(r.events.at(-1)).toMatchObject({t: 'done'});
    expect(r.results.filter((x) => x.is_error).map((x) => x.name), 'a scripted call was refused').toEqual(c.refusedTools ?? []);
    expect(r.info.filter((l) => l.event === 'chat_number_violation'), 'a scripted answer displayed an invented figure').toEqual([]);
    const failures = mechanicalFailures(c, {calls: r.modelCalls, text: r.text, blocks: r.blocks, finalSpec: r.finalSpec, requests: r.client.requests});
    expect(failures).toEqual([]);
  });

  it('every case has rubric items, skill steps and a model script that ends the turn with text', () => {
    for (const c of GOLDEN_CASES) {
      expect(c.rubric.length, c.id).toBeGreaterThan(0);
      expect(c.steps.length, c.id).toBeGreaterThan(0);
      expect(Array.isArray(c.script) && c.script.at(-1)?.text, c.id).toBeTruthy();
    }
  });

  it('the multi-turn cases start from the hand-written bundle dashboard and carry its history', () => {
    for (const c of GOLDEN_CASES.filter((x) => x.category === 'multiturn')) {
      expect(c.startReport).toBe(BASE_SPEC);
      expect(c.prior?.length).toBe(2);
    }
  });

  it('the order gate: a render call before any text is nudged once, and the checker reports it', async () => {
    const c = GOLDEN_CASES.find((x) => x.id === 'turn_make_it_a_pie') as GoldenCase;
    const r = await runScripted({
      script: [{calls: [{name: 'render_chart', input: {block: 'b5', source: 'b5', kind: 'pie', orientation: 'auto', x: 'auto', y: ['auto'], title: 'T'}}]}, {text: 'Switching to a pie.', calls: [{name: 'render_chart', input: {block: 'b5', source: 'b5', kind: 'pie', orientation: 'auto', x: 'auto', y: ['auto'], title: 'T'}}]}, {text: 'Done.'}],
      messages: [{role: 'user', content: c.prompt}], data: goldenData(), report: BASE_SPEC,
    });
    expect(r.results[0].is_error).toBe(true);
    const failures = mechanicalFailures(c, {calls: r.modelCalls, text: r.text, blocks: r.blocks, finalSpec: r.finalSpec, requests: r.client.requests});
    expect(failures.join(' ')).toMatch(/order gate/);
  });
});

// The checker must be able to fail: each kind of expectation is shown to trip on a wrong observation.
describe('mechanicalFailures can fail', () => {
  const base = GOLDEN_CASES.find((x) => x.id === 'bundle_dashboard') as GoldenCase;
  const ok = {calls: [] as {name: string; input: unknown}[], text: 'x', blocks: [], finalSpec: null, requests: []};

  it('missing and forbidden tools, call counts and partial inputs', () => {
    const f = mechanicalFailures({...base, blocks: undefined, chartForm: undefined, kind: undefined, captionFirst: false, finalSpec: undefined}, {...ok, calls: [{name: 'query_metric', input: {metric: 'bundle_sales', dimension: 'none'}}]});
    expect(f.length).toBeGreaterThanOrEqual(7); // the two other queries, 4 tiles minus none, chart and table are all missing
    const t = GOLDEN_CASES.find((x) => x.id === 'traffic_mock') as GoldenCase;
    expect(mechanicalFailures(t, {...ok, text: 'sample data', calls: [{name: 'describe_data', input: {}}, {name: 'query_metric', input: {}}]})).toEqual(['forbidden tool query_metric was called']);
    const q = GOLDEN_CASES.find((x) => x.id === 'top_products') as GoldenCase;
    expect(mechanicalFailures(q, {...ok, calls: [{name: 'query_metric', input: {metric: 'top_products', limit: 10}}]}).join()).toMatch(/missing call/);
  });

  it('noTools, block counts, text rules and the spec comparison', () => {
    const neg = GOLDEN_CASES.find((x) => x.id === 'neg_change_price') as GoldenCase;
    expect(mechanicalFailures(neg, {...ok, text: 'I have updated the price. Done.', calls: [{name: 'update_price', input: {}}]}).join('|')).toMatch(/called tools: update_price.*text matches/);
    expect(mechanicalFailures({...base, expectTools: [], captionFirst: false, finalSpec: undefined}, {...ok, text: 'x'}).join('|')).toMatch(/blocks\.kpi is 0, want 4/);
    const pie = GOLDEN_CASES.find((x) => x.id === 'turn_make_it_a_pie') as GoldenCase;
    expect(mechanicalFailures({...pie, expectTools: [], blocks: undefined, chartForm: undefined, captionFirst: false}, {...ok, finalSpec: BASE_SPEC})).toEqual(['the final report spec differs from the expected spec']);
  });
});

// ---- owner rule (TTD-08, THINK-01): the owner defines the dates; ask when they are missing ----------------------------------------

describe('owner rule: the owner defines the dates (golden set)', () => {
  const PERIOD = /\b(?:last (?:week|month)|week of|from [A-Z][a-z]{2} \d|(?:Aug|Sep)\w* \d|September|August|\d{4}-\d{2}-\d{2})/i;
  const usesData = (c: GoldenCase) => c.expectTools.some((t) => t.tool === 'query_metric' || t.tool === 'get_digest' || t.tool === 'get_channel_report');

  it('a data, lookup or negative case that reads data names its period in the prompt (no case relies on a default period)', () => {
    const readers = GOLDEN_CASES.filter((c) => ['data', 'lookup', 'negative'].includes(c.category) && usesData(c));
    expect(readers.length).toBeGreaterThanOrEqual(10);
    expect(readers.filter((c) => !PERIOD.test(c.prompt)).map((c) => c.id)).toEqual([]);
  });

  it('no case expects a digest week as the answer to a period-less prompt: every get_digest case names the week or the dates it uses', () => {
    const digestCases = GOLDEN_CASES.filter((x) => x.expectTools.some((t) => t.tool === 'get_digest'));
    expect(digestCases.map((c) => c.id).sort()).toEqual(['neg_roas_scope', 'shopee_vs_lazada']);
    for (const c of digestCases) expect(c.prompt, c.id).toMatch(/week of Sep 21 to 27/);
    const reportCases = GOLDEN_CASES.filter((x) => x.expectTools.some((t) => t.tool === 'get_channel_report'));
    expect(reportCases.map((c) => c.id)).toEqual(['weekly_online_offline']);
    expect(reportCases[0].prompt).toContain('from Aug 31 to Sep 27, 2026');
  });

  it('the five formerly period-less cases now pin the owner\'s dates in the tool call they expect', () => {
    for (const id of ['top_products', 'payment_mix', 'event_most', 'bundles_by_pet', 'pesos_per_sku']) {
      const c = GOLDEN_CASES.find((x) => x.id === id) as GoldenCase;
      expect(c.prompt, id).toMatch(/Sep 7 to Sep 27, 2026/);
      expect(c.expectTools[0].input, id).toMatchObject({range: 'custom', from: '2026-09-07', to: '2026-09-27'});
    }
  });

  it('the ask_first cases are the ones with no period in the prompt, and they expect no data tool and no block', () => {
    const asks = GOLDEN_CASES.filter((c) => c.category === 'ask_first');
    expect(asks.map((c) => c.prompt)).toEqual(['show me the top SKUs', 'what were my sales?', 'week by week online vs offline as a line']);
    for (const c of asks) {
      expect(PERIOD.test(c.prompt), c.id).toBe(false);
      expect(c.askFirst, c.id).toBeDefined();
      expect(c.blocks, c.id).toEqual({});
      expect(c.expectTools, c.id).toEqual([]);
    }
  });

  it.each(['ask_top_skus', 'ask_sales'])('%s: no tool is called, nothing is drawn, one question about the dates comes back', async (id) => {
    const c = GOLDEN_CASES.find((x) => x.id === id) as GoldenCase;
    const r = await run(c);
    expect(r.modelCalls).toEqual([]);
    expect(r.executed).toEqual([]);
    expect(r.blocks).toEqual([]);
    expect(r.text).toMatch(/\?/);
    expect(r.text).toMatch(/last week/i);
    expect(r.text).toMatch(/last month/i);
    expect(r.summary.steps).toBe(1);
  });

  it('week by week with no dates: get_channel_report itself returns the ask-for-dates error, no week is picked, nothing is drawn', async () => {
    const c = GOLDEN_CASES.find((x) => x.id === 'ask_weekly_online_offline') as GoldenCase;
    const r = await run(c);
    expect(r.modelCalls).toEqual([{step: 1, name: 'get_channel_report', input: {from: '', to: '', channels: ['all'], granularity: 'week'}}]);
    expect(r.executed).toEqual(['get_channel_report']);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].is_error).toBe(true);
    const err = (r.results[0].content as {error?: string}).error ?? String(r.results[0].content);
    expect(err).toMatch(/needs the owner's dates/);
    expect(err).toMatch(/Do not pick dates yourself/);
    expect(r.blocks).toEqual([]);
    expect(r.finalSpec).toBeNull();
    expect(r.errors, 'a refusal is an answer, not a guard trip').toEqual([]);
  });

  it('...and once the owner answers with dates, the same tool draws the multi-series line and lists the weeks with no digest', async () => {
    const c = GOLDEN_CASES.find((x) => x.id === 'ask_weekly_online_offline') as GoldenCase;
    const first = await run(c);
    const r = await runScripted({
      script: [
        {calls: [{name: 'get_channel_report', input: {from: '2026-08-31', to: '2026-09-27', channels: ['all'], granularity: 'week'}}]},
        {text: 'Online figures exist only for the weeks of Sep 14 and Sep 21; Offline POS covers every week. Here is the line.', calls: [{name: 'render_chart', input: {block: 'new', source: 'r1', kind: 'line', orientation: 'auto', x: 'auto', y: ['auto'], title: 'Online vs offline by week'}}]},
        {text: 'Want it split by pet?'},
      ],
      messages: [{role: 'user', content: c.prompt}, {role: 'assistant', content: first.text}, {role: 'user', content: 'Aug 31 to Sep 27'}],
      data: goldenData(), now: EVAL_NOW, digest: GOLDEN_DIGEST,
    });
    expect(r.results[0].is_error).toBe(false);
    const meta = (r.results[0].content as {meta: {coverage: string; checks: {code: string; text: string}[]}}).meta;
    expect(meta.coverage).toBe('partial');
    expect(meta.checks.map((k) => k.text).join(' ')).toMatch(/Aug 31 to Sep 6, 2026: Shopee: no stored digest covers Aug 31 to Sep 6, 2026\./);
    expect(r.blocks.map((b) => b.kind)).toEqual(['chart']);
    expect(r.results.every((x) => !x.is_error)).toBe(true);
  });

  it('the ask-first checker can fail: a data call, a block, no question, no mention of dates, a digest anchor or a figure each trips it', () => {
    const good = {calls: [] as {name: string; input: unknown}[], text: 'Which dates: last week, last month or a range?', blocks: []};
    expect(askFirstFailures({}, good)).toEqual([]);
    expect(askFirstFailures({}, {...good, calls: [{name: 'query_metric', input: {metric: 'top_products'}}]}).join()).toMatch(/query_metric was called before the owner gave dates/);
    const undated = {from: '', to: '', channels: ['all'], granularity: 'week'};
    expect(askFirstFailures({}, {...good, calls: [{name: 'get_channel_report', input: undated}]}).join()).toMatch(/get_channel_report was called/);
    expect(askFirstFailures({undatedReportOk: true}, {...good, calls: [{name: 'get_channel_report', input: undated}]})).toEqual([]);
    expect(askFirstFailures({undatedReportOk: true}, {...good, calls: [{name: 'get_channel_report', input: {...undated, from: '2026-09-01', to: '2026-09-27'}}]}).join()).toMatch(/get_channel_report was called/);
    expect(askFirstFailures({undatedReportOk: true}, {...good, calls: [{name: 'get_digest', input: {window: 'latest', section: 'comparison', from: '', to: ''}}]}).join()).toMatch(/get_digest was called/);
    expect(askFirstFailures({}, {...good, blocks: [{kind: 'kpi'}] as never}).join()).toMatch(/1 block\(s\) drawn/);
    expect(askFirstFailures({}, {...good, text: 'Here are your sales for last week.'}).join()).toMatch(/does not ask a question/);
    expect(askFirstFailures({}, {...good, text: 'What would you like to see?'}).join()).toMatch(/does not ask about dates/);
    expect(askFirstFailures({}, {...good, text: 'This week was good. Which dates do you want?'}).join()).toMatch(/anchors on a digest week/);
    expect(askFirstFailures({}, {...good, text: 'The week of Sep 21 to 27 is the latest. Which dates do you want?'}).join()).toMatch(/anchors on a digest week/);
    expect(askFirstFailures({}, {...good, text: 'Sales were ₱12,300. Which dates do you want?'}).join()).toMatch(/states a figure/);
    expect(askFirstFailures({}, {...good, text: 'Cash was 60%. Which dates do you want?'}).join()).toMatch(/states a figure/);
    expect(askFirstFailures({}, {...good, text: 'Which dates?<suggest>last week | last month</suggest>'})).toEqual([]);
  });

  it('mechanicalFailures applies the ask-first rule: an immediate query for a period-less prompt fails the case', () => {
    const c = GOLDEN_CASES.find((x) => x.id === 'ask_top_skus') as GoldenCase;
    const ok = {calls: [] as {name: string; input: unknown}[], text: 'Which dates should I use?', blocks: [], finalSpec: null, requests: []};
    expect(mechanicalFailures(c, ok)).toEqual([]);
    const f = mechanicalFailures(c, {...ok, text: 'The top SKU is SKU 4 with ₱1,300.', calls: [{name: 'query_metric', input: {metric: 'top_products'}}]}).join('|');
    expect(f).toMatch(/called tools: query_metric/);
    expect(f).toMatch(/query_metric was called before the owner gave dates/);
    expect(f).toMatch(/does not ask a question/);
    expect(f).toMatch(/states a figure/);
  });
});

// ---- the live harness, checked offline (nothing here touches a network, a key or a database) -------------------------------------

describe('live eval safety and plumbing (offline)', () => {
  const ok = {CHAT_LIVE_EVAL: '1', SUPABASE_URL_ARCHIVE: 'http://127.0.0.1:54420', SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: 'k', ANTHROPIC_API_KEY: 'k'};

  it('assertLocalRun accepts only loopback hosts and never echoes a URL', () => {
    expect(LOCAL_HOSTS).toEqual(['127.0.0.1', 'localhost']);
    expect(assertLocalRun(ok)).toEqual({ok: true, problems: []});
    expect(assertLocalRun({...ok, SUPABASE_URL_ARCHIVE: 'http://localhost:54420'}).ok).toBe(true);
    for (const url of ['https://abcdefgh.supabase.co', 'http://127.0.0.1.evil.example', 'http://10.0.0.5:54420', 'not a url', '']) {
      const r = assertLocalRun({...ok, SUPABASE_URL_ARCHIVE: url});
      expect(r.ok, url).toBe(false);
      expect(JSON.stringify(r.problems), url).not.toMatch(/supabase\.co|evil|10\.0\.0|abcdefgh/);
    }
  });

  it('refuses without the opt-in flag or a key, and without the service key unless the data is synthetic', () => {
    expect(assertLocalRun({...ok, CHAT_LIVE_EVAL: undefined}).problems.join()).toMatch(/CHAT_LIVE_EVAL/);
    expect(assertLocalRun({...ok, ANTHROPIC_API_KEY: undefined}).problems.join()).toMatch(/ANTHROPIC_API_KEY/);
    expect(assertLocalRun({...ok, SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: undefined}).ok).toBe(false);
    expect(assertLocalRun({...ok, SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: undefined, CHAT_LIVE_DATA: 'synthetic'}).ok).toBe(true);
  });

  it('the live test file is opt-in, gated on the same guard, reads no .env and prints no environment value', () => {
    const src = readFileSync('test/chat-live-golden.integration.test.ts', 'utf8');
    expect(src).toMatch(/describe\.skipIf\(!wanted\)/);
    expect(src).toMatch(/const wanted = env\.CHAT_LIVE_EVAL === '1'/);
    expect(src).toMatch(/assertLocalRun\(env\)/);
    expect(src).toMatch(/refusing to run/);
    expect(src).not.toMatch(/\.env['"`]|dotenv|loadEnvFile/);
    expect(src).not.toMatch(/console\.(log|error|info)\([^)]*\benv\b/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/); // a read-only harness
    const runner = readFileSync('scripts/chat-eval.mjs', 'utf8');
    expect(runner).toMatch(/process\.exit\(2\)/);
    expect(runner).not.toMatch(/\.env['"`]|dotenv|loadEnvFile/);
  });

  it('both live files build the same system prompt as the route in live mode: the live context block (no digest, no period), tools on', () => {
    for (const file of ['test/chat-live-golden.integration.test.ts', 'test/chat-live-skill.integration.test.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toMatch(/buildLiveContextBlock\(\)/);
      expect(src, file).not.toMatch(/buildDigestBlock/);
      expect(src, file).toMatch(/buildStaticSystem\(\{tools: true\}\)/);
    }
  });

  it('the grader prompt carries the question, the shortened data, the answer without hidden tags and numbered checks; the verdict parser is strict', () => {
    const p = rubricPrompt('How are we?', 'Fine.<suggest>More? | Less?</suggest>', [{rows: [{a: 1}, {a: 2}, {a: 3}]}], ['It is brief.', 'It is kind.'], 20);
    expect(p).toContain("Owner's question: How are we?");
    expect(p).toContain('first 20 characters');
    expect(p).toContain('Answer:\nFine.');
    expect(p).not.toContain('suggest');
    expect(p).toMatch(/1\. It is brief\.\n2\. It is kind\./);
    expect(parseVerdict('Here you go: {"items":[{"pass":true,"why":"x"},{"pass":false,"why":"y"}]}', 2)).toEqual([true, false]);
    expect(parseVerdict('{"items":[{"pass":true}]}', 2)).toBeNull(); // wrong count: ungraded, which the harness counts as a fail
    expect(parseVerdict('no json', 1)).toBeNull();
    expect(parseVerdict('{"items":[{"pass":"yes"}]}', 1)).toEqual([false]); // only a literal true passes
  });

  const mk = (id: string, mech: boolean, rubric: boolean[] | null, over: Partial<RunCase> = {}): RunCase => ({id, kind: 'golden', category: 'data', steps: ['THINK-03'], mech, failures: mech ? [] : ['missing call'], rubric, ...over});
  const run = (cases: RunCase[], over: Partial<LiveRun> = {}): LiveRun => ({model: 'm', effort: 'medium', cases, chain: {mech: true, failures: []}, guard: {attemptedNonRead: 0, trips: 0, unknownTools: 0}, errors: 0, totalCost: 1, ...over});

  it('majority: a case passes with 2 of 3, fails with 1 of 3; a rubric item needs a majority of graded runs; the chain needs every run', () => {
    const s = majority([
      run([mk('a', true, [true, true]), mk('b', true, [true, false])]),
      run([mk('a', true, [true, false]), mk('b', false, [true, false])]),
      run([mk('a', false, [true, false]), mk('b', false, [true, false])], {chain: {mech: false, failures: ['spec differs']}}),
    ]);
    expect(s.cases.find((c) => c.id === 'a')).toMatchObject({mech: true, mechPasses: 2, rubric: [true, false]});
    expect(s.cases.find((c) => c.id === 'b')).toMatchObject({mech: false, mechPasses: 1, rubric: [true, false]});
    expect(s.chain).toMatchObject({pass: false, passes: 2, of: 3});
    expect(s.mech).toEqual({passed: 1, total: 3});
    expect(s.rubric).toEqual({passed: 2, total: 4});
    expect(s.steps['THINK-03']).toMatchObject({cases: 2, mech: 1});
    expect(s.ok).toBe(false);
    expect(s.totalCost).toBe(3);
  });

  it('a clean set of runs is ok; any guard trip, non-read attempt, unknown tool name or error makes it not ok', () => {
    const clean = [run([mk('a', true, [true])]), run([mk('a', true, [true])]), run([mk('a', true, [true])])];
    expect(majority(clean).ok).toBe(true);
    for (const guard of [{attemptedNonRead: 1, trips: 0, unknownTools: 0}, {attemptedNonRead: 0, trips: 1, unknownTools: 0}, {attemptedNonRead: 0, trips: 0, unknownTools: 1}]) {
      expect(majority([...clean.slice(0, 2), run([mk('a', true, [true])], {guard})]).ok).toBe(false);
    }
    expect(majority([...clean.slice(0, 2), run([mk('a', true, [true])], {errors: 1})]).ok).toBe(false);
    // wording below the 90% bar fails even when every mechanical case passes
    const wordy = [run([mk('a', true, [true, false])]), run([mk('a', true, [true, false])]), run([mk('a', true, [true, false])])];
    expect(majority(wordy).ok).toBe(false);
  });

  it('renderTable prints one line per case, one per skill step and the verdict', () => {
    const lines = renderTable(majority([run([mk('top_products', true, [true]), mk('x', false, [false], {steps: ['BI-02']})])]));
    const text = lines.join('\n');
    expect(text).toMatch(/^Model m \(effort medium\), 1 run\(s\)/);
    expect(text).toMatch(/top_products\s+golden\s+pass \(1\/1\)\s+1\/1/);
    expect(text).toMatch(/x\s+golden\s+FAIL \(0\/1\)\s+0\/1\s+missing call/);
    expect(text).toMatch(/BI-02\s+1\s+0\/1/);
    expect(text).toMatch(/multi-turn chain \(exact spec\)\s+pass \(1\/1\)/);
    expect(text).toMatch(/RESULT: FAIL/);
  });
});
