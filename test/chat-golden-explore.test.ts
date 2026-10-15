// The Explore golden set, offline half (spec 9.2). No model call, no cost.
//  - Always runs: the set is well formed (25 + R01 + the live-only G08b), every reference key exists, every scripted query passes the real
//    validator (except the two refusal cases that must not), and the Day 6 live set is the small chosen one.
//  - Runs only on the local stack (EXPLORE_DATABASE_URL, SB_LOCAL_*, SB_PSQL_CMD from scripts/local-supabase/.local-env): REPLAY. A scripted
//    model drives the real loop, executors, parser and postgres client, and every answer is scored against reference figures computed
//    from the BASE tables by scripts/explore-golden-reference.sql (never typed here).
//   set -a; . scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-golden-explore.test.ts
// The live half (real model, budgeted) is test/chat-golden-explore.integration.test.ts.
import {readFileSync} from 'node:fs';
import {beforeAll, describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {computeExpected, parseReferenceSql} from '../scripts/explore-golden-expected.mjs';
import {validateExploreSql} from '../src/chat/explore/parse';
import {TOOL_ALLOWLIST} from '../src/chat/tools';
import {EXPLORE_GOLDEN, GOLDEN_IDS, LIVE_SET, type VerifyContext} from './support/explore-golden';
import {loadGoldenWorld, localWorldEnv, runGoldenCase, scoreGolden, scriptedModelFor, type GoldenWorld} from './support/explore-golden-run';

const REFERENCE_SQL = readFileSync(new URL('../scripts/explore-golden-reference.sql', import.meta.url), 'utf8');
const KEYS = parseReferenceSql(REFERENCE_SQL).map((b) => b.key);

describe('EXP-03 the golden set is well formed', () => {
  it('EXP-03 has the 35 questions G01..G35 once each, plus the regression R01, the live-only variant G08b and the A7 pet-split case A07', () => {
    expect(GOLDEN_IDS).toEqual(Array.from({length: 35}, (_, i) => `G${String(i + 1).padStart(2, '0')}`));
    expect(EXPLORE_GOLDEN.map((c) => c.id).filter((id) => !GOLDEN_IDS.includes(id)).sort()).toEqual(['A07', 'G08b', 'R01']);
    expect(new Set(EXPLORE_GOLDEN.map((c) => c.id)).size).toBe(EXPLORE_GOLDEN.length);
  });

  it('EXP-03 G01 is the SM Aura / Circuit Makati pet question, G25 the injection case, R01 the attribution regression', () => {
    const by = (id: string) => EXPLORE_GOLDEN.find((c) => c.id === id)!;
    expect(by('G01').question).toMatch(/SM Aura/);
    expect(by('G01').question).toMatch(/Circuit Makati/);
    expect(by('G01').question).toMatch(/pet type/i);
    expect(by('G25').invariant).toBe('I-INJECT');
    expect(by('R01').invariant).toBe('I-FIGURES');
    expect(by('R01').mustCall).toEqual(['query_metric', 'run_query']);
  });

  it('EXP-03 every case names a path, a tool path, an invariant and a rubric; the tools it may call exist', () => {
    for (const c of EXPLORE_GOLDEN) {
      expect(c.question.length, c.id).toBeGreaterThan(10);
      expect(c.rubric.length, c.id).toBeGreaterThan(0);
      for (const n of c.mustCall) expect(TOOL_ALLOWLIST as readonly string[], `${c.id} mustCall ${n}`).toContain(n);
      for (const s of c.script.flat()) expect(TOOL_ALLOWLIST as readonly string[], `${c.id} script ${s.name}`).toContain(s.name);
      for (const n of c.mustCall) expect(c.mustNotCall, c.id).not.toContain(n);
    }
  });

  it('EXP-03 every reference and every compare points at a block of scripts/explore-golden-reference.sql, and every block is a SELECT', () => {
    for (const c of EXPLORE_GOLDEN) {
      if (c.reference) expect(KEYS, `${c.id} reference`).toContain(c.reference);
      for (const x of c.compares ?? []) expect(KEYS, `${c.id} compare`).toContain(x.ref);
    }
    for (const b of parseReferenceSql(REFERENCE_SQL) as {key: string; sql: string}[]) {
      expect(b.sql, b.key).toMatch(/^\s*(select|with)\b/i);
      expect(b.sql, b.key).not.toMatch(/\b(insert|update|delete|drop|alter|create|grant|truncate)\b/i);
    }
  });

  it('EXP-03 no figure is typed into the set: the reference file and the cases hold no expected-value literal', () => {
    const src = readFileSync(new URL('./support/explore-golden.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/expected[A-Za-z]*\s*[:=]\s*[0-9]/);
    expect(src).not.toMatch(/₱\s*[0-9]/);
  });

  it('EXP-03 every scripted run_query passes the real validator, except the write and the secret probe that must be refused', async () => {
    const refused: Record<string, string> = {G22: 'E_NOT_SELECT', G23: 'E_BLOCKED_COLUMN', G35: 'E_BLOCKED_COLUMN'};
    for (const c of EXPLORE_GOLDEN) {
      for (const call of c.script.flat().filter((x) => x.name === 'run_query')) {
        const v = await validateExploreSql(call.input.sql);
        if (refused[c.id]) {
          expect(v.ok, c.id).toBe(false);
          expect(v.ok ? '' : v.code, c.id).toBe(refused[c.id]);
        } else {
          expect(v.ok, `${c.id}: ${v.ok ? '' : v.code}`).toBe(true);
          if (v.ok && c.views) for (const rel of v.relations) expect(c.views, `${c.id} reads ${rel}`).toContain(rel);
        }
      }
    }
  });

  it('EXP-03 the live set is 11 questions: the Day 6 eight plus the stock, stock-cover and completed-basis cases (Task 8 fix 1)', () => {
    expect(LIVE_SET.map((c) => c.id)).toEqual(['G01', 'G04', 'G08b', 'G14', 'G15', 'G20', 'G25', 'R01', 'G26', 'G28', 'G33']);
    expect(LIVE_SET.every((c) => c.liveWhy && c.liveWhy.length > 20)).toBe(true);
  });
});

const local = localWorldEnv();
describe.skipIf(!local)('EXP-03 replay: a scripted model through the real loop, parser and client, scored against the base tables (local Postgres only)', () => {
  let world: GoldenWorld;
  let expected: VerifyContext['expected'];
  beforeAll(async () => {
    world = await loadGoldenWorld();
    expected = computeExpected() as VerifyContext['expected'];
  });

  it('EXP-03 the references were computed from the fixture (every key returned an array, none typed)', () => {
    for (const k of KEYS) expect(Array.isArray(expected[k]), k).toBe(true);
    expect(expected.G01_pet_event.length).toBeGreaterThan(0);
  });

  it.each(EXPLORE_GOLDEN.map((c) => [c.id, c] as const))('EXP-03 %s replays and matches the reference', async (_id, kase) => {
    const client = scriptedModelFor(kase, expected);
    const observed = await runGoldenCase({kase, world, client});
    const problems = scoreGolden(kase, observed, expected, {strictText: true});
    expect(problems, `${kase.id}: ${problems.join(' | ')}\nANSWER: ${observed.text.slice(0, 600)}`).toEqual([]);
  });

  it('EXP-03 a mutated reference is caught: the scorer can fail', async () => {
    const kase = EXPLORE_GOLDEN.find((c) => c.id === 'G03')!;
    const bad = {...expected, G03: [{voided_count: 999}]};
    const observed = await runGoldenCase({kase, world, client: scriptedModelFor(kase, bad)});
    expect(scoreGolden(kase, observed, bad, {strictText: true}).join('|')).toMatch(/voided_count/);
  });
});
