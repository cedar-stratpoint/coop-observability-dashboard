// The Business Health Report ships ONE SQL file, the final schema only (2026-11-06): no hosted database ever had the plan tables (staging
// checked), so there is nothing to migrate and nothing to drop. Source checks; the local integration tests (npm run test:plan-local) apply it.
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const planFiles = (text: string) => [...text.matchAll(/supabase\/(plan_[a-z_]+\.sql)|`(plan_[a-z_]+\.sql)`/g)].map((m) => m[1] ?? m[2]);
const sql = read('supabase/plan_report.sql');

describe('the plan SQL is one file, final schema only', () => {
  it('supabase/plan_report.sql is the only supabase/plan_*.sql file', () => {
    expect(readdirSync(path.join(root, 'supabase')).filter((f) => /^plan_.*\.sql$/.test(f))).toEqual(['plan_report.sql']);
  });
  it('drops no plan_ table or function', () => {
    expect(sql).not.toMatch(/drop\s+(table|function)\s+(if\s+exists\s+)?(public\.)?plan_/i);
  });
  it('has no source column on plan_actuals', () => {
    expect(sql).not.toMatch(/\bsource\b/i);
  });
  it('the local stack applies plan_report.sql and no other plan_ file', () => {
    expect(planFiles(read('scripts/local-supabase/up.sh'))).toEqual(['plan_report.sql']);
  });
  it('the CHANGELOG apply note names plan_report.sql only', () => {
    const note = read('CHANGELOG.md').split('\n').find((l) => l.startsWith('Apply on staging by hand'))!;
    expect(planFiles(note)).toEqual(['plan_report.sql']);
  });
});
