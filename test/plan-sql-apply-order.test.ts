// BHR-06 review M5: the documented manual apply order (supabase/plan_report.sql header, scripts/local-supabase/up.sh, CHANGELOG) must not resurrect the
// retired breakdown RPC, and no longer applies plan_part_targets.sql (nothing reads or writes that table). Source checks; the local integration test
// test/plan-itemise-local.integration.test.ts re-applies the files on the local stack and checks pg_proc.
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const ORDER = ['plan_report.sql', 'plan_actuals_drop_derived.sql', 'plan_actuals_remove_workbook_prefill.sql', 'plan_actual_parts.sql', 'plan_actuals_itemise.sql'];
const planFiles = (text: string) => [...text.matchAll(/supabase\/(plan_[a-z_]+\.sql)|`(plan_[a-z_]+\.sql)`/g)].map((m) => m[1] ?? m[2]);

describe('M5: the plan SQL apply order', () => {
  it('no SQL file creates plan_set_actual_parts any more', () => {
    for (const f of readdirSync(path.join(root, 'supabase')).filter((x) => x.endsWith('.sql'))) {
      expect(read(`supabase/${f}`), f).not.toMatch(/create\s+(or\s+replace\s+)?function\s+(public\.)?plan_set_actual_parts/i);
    }
  });
  it('the local stack applies the plan files in the documented order, without plan_part_targets.sql', () => {
    const loop = read('scripts/local-supabase/up.sh').split('\n').find((l) => l.includes('supabase/plan_report.sql'))!;
    expect(planFiles(loop)).toEqual(ORDER);
  });
  it('plan_report.sql names the same order in its header', () => {
    expect([...new Set(planFiles(read('supabase/plan_report.sql').split('\n')[1]))]).toEqual(ORDER.slice(1));
  });
  it('the CHANGELOG apply note names the same order', () => {
    const note = read('CHANGELOG.md').split('\n').find((l) => l.startsWith('Apply on staging by hand in this order'))!;
    expect(planFiles(note.split('. ')[0])).toEqual(ORDER); // the order sentence itself
  });
});
