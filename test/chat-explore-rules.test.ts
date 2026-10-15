// A rule that the code enforces must have a test whose title names it (spec 6.3). Fails when a `code` EXP rule has none.
import {readdirSync, readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {RULES} from '../src/chat/skills/rules';

const files = readdirSync('test').filter((f) => /\.test\.[tj]sx?$/.test(f) && f !== 'chat-explore-rules.test.ts');
const titles = files.flatMap((f) => [...readFileSync(`test/${f}`, 'utf8').matchAll(/\b(?:it|test|describe)(?:\.each\([^)]*\))?\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((m) => `${f}: ${m[2]}`));

describe('EXP rules each have a test title naming them', () => {
  const codeRules = RULES.filter((r) => r.id.startsWith('EXP-') && r.enforcedBy === 'code');
  it('there are code-enforced EXP rules to check', () => {
    expect(codeRules.map((r) => r.id)).toEqual(['EXP-01', 'EXP-02', 'EXP-03', 'EXP-04', 'EXP-05', 'EXP-07']);
  });
  it.each(codeRules.map((r) => r.id))('%s has at least one test title that contains it', (id) => {
    expect(titles.filter((t) => t.includes(id)).length, id).toBeGreaterThan(0);
  });
  it('EXP-08 is a guide rule (the framing of a group claim) and needs no test title', () => {
    expect(RULES.find((r) => r.id === 'EXP-08')?.enforcedBy).toBe('guide');
  });
  it('EXP-06 is a guide rule and needs no test title', () => {
    expect(RULES.find((r) => r.id === 'EXP-06')?.enforcedBy).toBe('guide');
  });
});
