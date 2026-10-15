// Every worked example the model is shown must pass the real validator (spec 6.6), or the prompt would teach SQL the gate refuses.
import {describe, expect, it} from 'vitest';
import {EXPLORE_EXAMPLES} from '../src/chat/explore/examples';
import {validateExploreSql} from '../src/chat/explore/parse';

describe('EXP-02 the worked examples pass the real validator', () => {
  it('EXP-02 there are 18 examples', () => {
    expect(EXPLORE_EXAMPLES).toHaveLength(18);
  });
  it.each(EXPLORE_EXAMPLES.map((e) => [e.id, e.sql]))('EXP-02 %s is accepted', async (_id, sql) => {
    const v = await validateExploreSql(sql);
    expect(v.ok, v.ok ? '' : `${v.code}`).toBe(true);
  });
  it('EXP-02 the one-label-per-event SQL (collate "C" plus a window over an aggregate) passes the parser and validator', async () => {
    const sql = "select min(min(btrim(e.name) collate \"C\")) over (partition by lower(btrim(e.name))) as event, count(*) as orders_count from coop_explore_orders o join coop_explore_events e on e.event_id = o.event_id where o.status = 'completed' group by lower(btrim(e.name))";
    const v = await validateExploreSql(sql);
    expect(v.ok, v.ok ? '' : `${v.code}`).toBe(true);
  });
  it('EXP-02 only the "C" collation is allowed; any other collation is refused', async () => {
    for (const c of ['"en_US"', '"POSIX"', 'pg_catalog."default"']) {
      const v = await validateExploreSql(`select min(btrim(e.name) collate ${c}) as event from coop_explore_events e group by lower(btrim(e.name))`);
      expect(v.ok, c).toBe(false);
    }
  });
});
