import {describe, expect, it} from 'vitest';
import {EXPLORE_EXTRA_CORPUS, EXPLORE_NEGATIVE_CORPUS, EXPLORE_POSITIVE_CORPUS, type ExploreCorpusRow} from './support/explore-corpus';
import {
  CURSOR_NAME,
  EXPLORE_CASTS,
  EXPLORE_DENIED_FUNCTIONS,
  EXPLORE_FUNCTIONS,
  EXPLORE_NODE_TYPES,
  EXPLORE_OPERATORS,
  createExploreValidator,
  validateExploreSql,
  wrapCursor,
} from '../src/chat/explore/parse';
import {
  EXPLORE_COLUMN_PATTERN_EXCEPTIONS,
  EXPLORE_ERROR_CLASS,
  EXPLORE_ERROR_MESSAGES,
  EXPLORE_FUNCTION_NAMES,
  type ExploreErrorCode,
} from '../src/chat/explore/types';

// Spec 4.7 (corpus), 4.8 (mutation checks). The corpus is plain data (test/support/explore-corpus.mjs) shared with the raw role proof
// (scripts/coop-explore-ro-proof.mjs). Every `expect: 'ok'` row is a positive control: the gate must not over-block.

const tripFor = (code: ExploreErrorCode) => ({H: 'hard', S: 'soft'} as Record<string, 'hard' | 'soft'>)[EXPLORE_ERROR_CLASS[code]] ?? null;
const ALL: ExploreCorpusRow[] = [...EXPLORE_NEGATIVE_CORPUS, ...EXPLORE_EXTRA_CORPUS];
const byId = (id: string) => ALL.find((r) => r.id === id) as ExploreCorpusRow;

describe('EXP-02 corpus shape', () => {
  it('has the 91 spec rows with unique ids N01..N91, plus the extra and positive rows', () => {
    expect(EXPLORE_NEGATIVE_CORPUS.map((r) => r.id)).toEqual(Array.from({length: 91}, (_, i) => `N${String(i + 1).padStart(2, '0')}`));
    const ids = [...ALL, ...EXPLORE_POSITIVE_CORPUS].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EXPLORE_NEGATIVE_CORPUS.filter((r) => r.expect !== 'ok').length).toBeGreaterThanOrEqual(69);
  });
  it('N89-N91 (the read-only-transaction escapes found on Day 1) are in the corpus', () => {
    expect(byId('N89').sql).toBe('set transaction read write');
    expect(byId('N90').sql).toBe('commit; insert into pos_orders (total) values (1)');
    expect(byId('N91').sql).toBe('select 1; insert into pos_orders (total) values (1)');
    for (const id of ['N89', 'N90', 'N91']) expect(byId(id).expect).toMatch(/E_NOT_SELECT|E_MULTI_STATEMENT/);
  });
});

describe('EXP-02 negative corpus: validateExploreSql refuses every row (the parser layer)', () => {
  it.each(ALL.map((r) => [r.id, r] as const))('%s', async (_id, r) => {
    const res = await validateExploreSql(r.sql);
    if (r.expect === 'ok') {
      expect(res.ok, JSON.stringify(res)).toBe(true);
      return;
    }
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(r.expect);
    expect(res.trip).toBe(tripFor(r.expect));
    // Messages are fixed constants: never the SQL, never database text. (E_SYNTAX carries only the offset.)
    if (r.expect === 'E_SYNTAX') expect(res.message).toMatch(/^SQL syntax error( near character \d+)?\.$/);
    else expect(res.message).toBe(EXPLORE_ERROR_MESSAGES[r.expect]);
    expect(res.message).not.toContain('drop table');
  });
});

describe('EXP-02 positive controls: the gate does not over-block (examples and allowlisted constructs)', () => {
  it.each(EXPLORE_POSITIVE_CORPUS.map((r) => [r.id, r] as const))('%s validates', async (_id, r) => {
    const res = await validateExploreSql(r.sql);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.sent).toBe(wrapCursor(r.sql));
      expect(res.sql).toBe(r.sql);
      expect(res.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(res.literalsHash).toMatch(/^[0-9a-f]{12}$/);
    }
  });
  it('N74 is exactly 2000 characters and passes; N72 is 2001 and fails', async () => {
    expect(byId('N74').sql).toHaveLength(2000);
    expect(byId('N72').sql).toHaveLength(2001);
  });
});

describe('EXP-01 name every column: select * is refused, count(*) is not', () => {
  it('N57 select *, N58 o.* are E_SELECT_STAR; N59 count(*) is fine', async () => {
    expect((await validateExploreSql(byId('N57').sql))).toMatchObject({ok: false, code: 'E_SELECT_STAR', trip: null});
    expect((await validateExploreSql(byId('N58').sql))).toMatchObject({ok: false, code: 'E_SELECT_STAR', trip: null});
    expect((await validateExploreSql(byId('N59').sql)).ok).toBe(true);
  });
  it('a star hidden in a CTE or a sub-select is still refused', async () => {
    expect(await validateExploreSql('with a as (select * from coop_explore_orders) select a.id from a')).toMatchObject({code: 'E_SELECT_STAR'});
    expect(await validateExploreSql('select x.id from (select o.* from coop_explore_orders o) x')).toMatchObject({code: 'E_SELECT_STAR'});
  });
});

describe('EXP-02 what a valid result reports', () => {
  it('returns the relations, ctes, functions and output column names', async () => {
    const res = await validateExploreSql(
      "with ev as (select e.event_id from coop_explore_events e where e.name ilike '%x%') select coalesce(o.pet_type, 'untagged') as pet, count(*) as orders_count, round(sum(o.total), 2) as revenue_php, o.status from coop_explore_orders o join ev on ev.event_id = o.event_id group by 1, 4",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.relations.sort()).toEqual(['coop_explore_events', 'coop_explore_orders']);
    expect(res.ctes).toEqual(['ev']);
    expect(res.functions).toEqual(expect.arrayContaining(['count', 'round', 'sum']));
    expect(res.outputColumns).toEqual(['pet', 'orders_count', 'revenue_php', 'status']);
  });
  it('the wrapper is the documented DECLARE form', () => {
    expect(wrapCursor('select 1')).toBe(`DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR select 1`);
  });
  it('returns the input unchanged (no rewriting) and never throws on garbage', async () => {
    for (const bad of [undefined, null, 42, {}, [], true]) expect(await validateExploreSql(bad)).toMatchObject({ok: false, code: 'E_INPUT'});
    const sql = ' select o.id from coop_explore_orders o ;  ';
    const res = await validateExploreSql(sql);
    expect(res.ok && res.sql).toBe(sql);
  });
});

describe('EXP-05 lint W_NO_STATUS_FILTER', () => {
  it('flags orders without any status column, not when status is used anywhere', async () => {
    const a = await validateExploreSql('select count(*) as orders_count from coop_explore_orders o');
    expect(a.ok && a.lints.map((l) => l.code)).toEqual(['W_NO_STATUS_FILTER']);
    const b = await validateExploreSql("select count(*) as orders_count from coop_explore_orders o where o.status = 'completed'");
    expect(b.ok && b.lints).toEqual([]);
    const c = await validateExploreSql('select count(*) as events_count from coop_explore_events e');
    expect(c.ok && c.lints).toEqual([]);
    const d = await validateExploreSql('select o.status, count(*) as orders_count from coop_explore_orders o group by 1');
    expect(d.ok && d.lints).toEqual([]);
  });
});

describe('EXP-02 priority: hard trips are always reported as trips', () => {
  it('a statement that breaks several rules reports the first in the priority list', async () => {
    // E_RELATION (pos_orders), E_BLOCKED_COLUMN (api_key), E_FUNCTION_DENIED (pg_sleep), E_CATALOG (pg_class): hard ones win.
    const r = await validateExploreSql('select o.api_key, pg_sleep(1) as s from pos_orders o join pg_class c on c.oid = o.id');
    expect(r).toMatchObject({ok: false, code: 'E_CATALOG', trip: 'hard'});
    const s = await validateExploreSql('select o.api_key from pos_orders o');
    expect(s).toMatchObject({ok: false, code: 'E_BLOCKED_COLUMN', trip: 'soft'});
    const t = await validateExploreSql('select * from pos_orders'); // Train 3: the base table is readable, the star is not
    expect(t).toMatchObject({ok: false, code: 'E_SELECT_STAR'});
  });
  it('the error table is complete: every code has a class and a constant message', () => {
    for (const code of Object.keys(EXPLORE_ERROR_MESSAGES) as ExploreErrorCode[]) {
      expect(EXPLORE_ERROR_CLASS[code]).toMatch(/^[RSHL]$/);
      expect(EXPLORE_ERROR_MESSAGES[code].length).toBeGreaterThan(5);
      expect(EXPLORE_ERROR_MESSAGES[code]).not.toMatch(/drop |insert /i);
    }
    expect(EXPLORE_ERROR_MESSAGES.E_RELATION).toMatch(/Secret tables/);
  });
  it('the exported allowlists match the contract', () => {
    expect(EXPLORE_FUNCTIONS).toEqual(EXPLORE_FUNCTION_NAMES);
    expect(EXPLORE_FUNCTIONS).toHaveLength(40);
    expect(EXPLORE_CASTS).toHaveLength(9);
    for (const f of EXPLORE_DENIED_FUNCTIONS) expect(EXPLORE_FUNCTIONS).not.toContain(f);
    expect(EXPLORE_OPERATORS).toEqual(expect.arrayContaining(['+', '->>', '~~*', '~*']));
    expect(EXPLORE_NODE_TYPES).toEqual(expect.arrayContaining(['SelectStmt', 'RangeVar', 'FuncCall']));
    expect(EXPLORE_NODE_TYPES).not.toContain('InsertStmt');
  });
});

describe('EXP-02 mutation: a gate must be able to fail (spec 4.8)', () => {
  it('(1) with pg_sleep added to the function allowlist, N38 passes: the corpus row is load-bearing', async () => {
    const broken = createExploreValidator({functions: [...EXPLORE_FUNCTIONS, 'pg_sleep'], deniedFunctions: [], deniedPrefixes: []});
    expect(await validateExploreSql(byId('N38').sql)).toMatchObject({ok: false, code: 'E_FUNCTION_DENIED'});
    expect((await broken(byId('N38').sql)).ok).toBe(true);
  });
  it('(1b) emptying the denylist alone turns N38 into E_FUNCTION (the allowlist still stops it)', async () => {
    const half = createExploreValidator({deniedFunctions: [], deniedPrefixes: []});
    expect(await half(byId('N38').sql)).toMatchObject({ok: false, code: 'E_FUNCTION'});
  });
  it('(2) with the node-type allowlist emptied, the positives N59 and N88 fail: the positive controls are load-bearing', async () => {
    const closed = createExploreValidator({nodeTypes: []});
    for (const id of ['N59', 'N88']) {
      expect((await validateExploreSql(byId(id).sql)).ok).toBe(true);
      expect(await closed(byId(id).sql)).toMatchObject({ok: false, code: 'E_NODE'});
    }
  });
  it('(2b) with the relation rule opened to every name, a secret table passes: the name rule is load-bearing', async () => {
    const wide = createExploreValidator({relationAllowed: () => true});
    const sql = 'select m.marketplace from marketplace_tokens m';
    expect(await validateExploreSql(sql)).toMatchObject({ok: false, code: 'E_RELATION'});
    expect((await wide(sql)).ok).toBe(true);
  });
  it('(3) the wrapper check catches a parser that disagrees about the string it will send; skipping it lets that through', async () => {
    // A stub parse that, for the wrapped string only, returns a DECLARE whose query differs from the standalone SELECT.
    const {parse} = await import('libpg-query');
    const disagree = async (s: string) => {
      const ast = (await parse(s)) as {stmts: {stmt: Record<string, any>}[]};
      const d = ast.stmts[0]?.stmt?.DeclareCursorStmt;
      if (d) d.query.SelectStmt.targetList = [];
      return ast;
    };
    const guarded = createExploreValidator({parse: disagree});
    const skipping = createExploreValidator({parse: disagree, skipWrapperCheck: true});
    const sql = 'select o.id from coop_explore_orders o';
    expect(await guarded(sql)).toMatchObject({ok: false, code: 'E_WRAPPER_MISMATCH', trip: 'hard'});
    expect((await skipping(sql)).ok).toBe(true);
  });
  it('(3b) the wrapper must be a single NO SCROLL DECLARE: a WITH HOLD or a second statement in the wrapped parse is a mismatch', async () => {
    const {parse} = await import('libpg-query');
    const holdy = async (s: string) => {
      const ast = (await parse(s)) as {stmts: {stmt: Record<string, any>}[]};
      const d = ast.stmts[0]?.stmt?.DeclareCursorStmt;
      if (d) d.options |= 0x20; // CURSOR_OPT_HOLD
      return ast;
    };
    expect(await createExploreValidator({parse: holdy})('select o.id from coop_explore_orders o')).toMatchObject({code: 'E_WRAPPER_MISMATCH'});
    const extra = async (s: string) => {
      const ast = (await parse(s)) as {stmts: unknown[]};
      if (s.startsWith('DECLARE')) ast.stmts.push(ast.stmts[0]);
      return ast;
    };
    expect(await createExploreValidator({parse: extra})('select o.id from coop_explore_orders o')).toMatchObject({code: 'E_WRAPPER_MISMATCH'});
  });
  it('(3c) an unexpected exception inside the validator fails closed as E_WRAPPER_MISMATCH', async () => {
    const boom = createExploreValidator({parse: async () => { throw new Error('wasm exploded'); }});
    expect(await boom('select o.id from coop_explore_orders o')).toMatchObject({ok: false, code: 'E_WRAPPER_MISMATCH', trip: 'hard'});
  });
  it('(4) the column-pattern exception list is empty and stays empty until a reviewed diff changes this test', () => {
    expect(EXPLORE_COLUMN_PATTERN_EXCEPTIONS).toEqual([]);
  });
  it('(5) with the blocked-column check removed, N54 passes', async () => {
    const lax = createExploreValidator({secretName: () => false});
    expect((await lax(byId('N54').sql)).ok).toBe(true);
  });
});

describe('EXP-02 limits are injectable and only ever tighten what the env says', () => {
  it('maxCols, maxRelations, maxSqlChars and maxDepth come from the limits argument', async () => {
    expect(await validateExploreSql('select o.id, o.total from coop_explore_orders o', {maxCols: 1})).toMatchObject({code: 'E_TOO_MANY_COLUMNS'});
    expect(await validateExploreSql('select o.id from coop_explore_orders o', {maxSqlChars: 10})).toMatchObject({code: 'E_TOO_LONG'});
    expect(await validateExploreSql('select o.id from coop_explore_orders o join coop_explore_orders p on p.id = o.id', {maxRelations: 1})).toMatchObject({code: 'E_TOO_MANY_RELATIONS'});
    expect(await validateExploreSql('select x.id from (select o.id from coop_explore_orders o) x', {maxDepth: 1})).toMatchObject({code: 'E_TOO_DEEP'});
  });
});
