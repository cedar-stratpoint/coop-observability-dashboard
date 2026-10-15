import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {buildStaticSystem} from '../src/chat/context';
import {SMALL_SAMPLE_N} from '../src/chat/checks';
import {estimateTokens, renderSkill} from '../src/chat/skills/load';
import {EXPLORE_TOPICS, RULES, SKILL_CONSTANTS, SKILL_TOPICS} from '../src/chat/skills/rules';
import {KPI_MAX, PIE_MAX_SEGMENTS, SERIES_FOLD_AT, TABLE_MIN_CLASSES} from '../src/chat/recommend-view';

const SKILL_DIR = path.join(process.cwd(), 'src/chat/skills/ask-coop-data-analyst');
const text = renderSkill();
const TAG = /\[([A-Z]+-\d+)( ⚙)?\]/g;
const tagsOf = (t: string) => [...t.matchAll(TAG)].map((m) => ({id: m[1], gear: Boolean(m[2])}));
const tags = tagsOf(text);
const exploreText = renderSkill({explore: true});
const exploreTags = tagsOf(exploreText);
// sha256 of the non-explore render (16,089 characters). Re-pinned 2026-10-07 (Train 3): the page-context topic (PAGE-01) was added on purpose.
// Re-pinned again 2026-10-07 (Train 3 Task 8 fix 1): THINK-01 gained the stock-has-no-period exception.
// The original pre-Explore hash was 963c0e5c4a98... (15,668 characters, fix/ask-coop b28abd0).
const BASELINE_SHA256 = 'b129c1b98d92a62a2dff8171df601726f9da79ece7df10709c22aac2489be9ce';

function fixtureDir(files: {skill: string; topic?: string}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'skill-'));
  mkdirSync(path.join(dir, 'topics'));
  writeFileSync(path.join(dir, 'SKILL.md'), files.skill);
  for (const t of [...SKILL_TOPICS, ...EXPLORE_TOPICS]) writeFileSync(path.join(dir, 'topics', `${t}.md`), files.topic ?? `# ${t}\n\nPlain.`);
  return dir;
}
const skillWith = (body: string) => `---\nname: ask-coop-data-analyst\ndescription: test\n---\n\n# Title\n\n${body}\n`;

describe('rule ids stay in sync between the text and rules.ts', () => {
  it('every tag in the text exists in RULES (both variants)', () => {
    const known = new Set(RULES.map((r) => r.id));
    expect(tags.filter((t) => !known.has(t.id)).map((t) => t.id)).toEqual([]);
    expect(exploreTags.filter((t) => !known.has(t.id)).map((t) => t.id)).toEqual([]);
  });
  // S1S#5: a rule id removed from rules.ts but still tagged in the text must fail. Same extraction and predicate as above, on a text
  // that plants a stale tag and a rule that appears twice, to show the gate can fail.
  it('the gate can fail: a stale tag in the text, or a rule tagged twice, is caught', () => {
    const dir = fixtureDir({skill: skillWith('[THINK-01] Understand.\n\n[OLD-99] A rule that was removed from rules.ts.\n\n[THINK-01] Understand, again.')});
    const planted = [...renderSkill({dir, constants: {}}).matchAll(/\[([A-Z]+-\d+)( ⚙)?\]/g)].map((m) => m[1]);
    const known = new Set(RULES.map((r) => r.id));
    expect(planted.filter((id) => !known.has(id))).toEqual(['OLD-99']);
    expect(planted.filter((id) => id === 'THINK-01')).toHaveLength(2);
  });
  const count = (ts: typeof tags, id: string) => ts.filter((t) => t.id === id).length;
  it('every RULES id appears exactly once in the explore variant; EXP-* never in the non-explore one', () => {
    expect(RULES.filter((r) => count(exploreTags, r.id) !== 1).map((r) => r.id)).toEqual([]);
    expect(RULES.filter((r) => count(tags, r.id) !== (r.id.startsWith('EXP-') ? 0 : 1)).map((r) => r.id)).toEqual([]);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
  it('the gear tag is on exactly the rules enforced in code (both variants)', () => {
    const byId = new Map(RULES.map((r) => [r.id, r.enforcedBy]));
    expect(tags.filter((t) => t.gear !== (byId.get(t.id) === 'code')).map((t) => t.id)).toEqual([]);
    expect(exploreTags.filter((t) => t.gear !== (byId.get(t.id) === 'code')).map((t) => t.id)).toEqual([]);
  });
});

describe('explore markers', () => {
  it('keep the right variant, never leak, and an unbalanced marker throws', () => {
    const dir = fixtureDir({skill: skillWith('A\n[[explore]]\nE\n[[/explore]]\n[[!explore]]\nN\n[[/!explore]]\nZ')});
    expect(renderSkill({dir, constants: {}})).toContain('A\nN\nZ');
    expect(renderSkill({dir, constants: {}, explore: true})).toContain('A\nE\nZ');
    expect(renderSkill({dir, constants: {}})).not.toMatch(/\[\[/);
    const bad = fixtureDir({skill: skillWith('A\n[[explore]]\nE\nZ')});
    expect(() => renderSkill({dir: bad, constants: {}, explore: true})).toThrow(/Unbalanced/);
  });
  it('the explore edits to THINK-01, 02, 03 and 07 are only in the explore variant', () => {
    for (const s of ['all available data', 'run_query cannot answer it', 'from the rows of a query you ran', 'Exploratory, not a registered metric']) {
      expect(exploreText).toContain(s);
      expect(text).not.toContain(s);
    }
    for (const s of ['ask which dates before any tool call', 'Say "not available" only when no metric declares the measure, and then']) {
      expect(text).toContain(s);
    }
  });
});

describe('placeholders and constants', () => {
  it('leaves no placeholder in the rendered text', () => {
    expect(text).not.toMatch(/\{\{.*?\}\}/);
  });
  it('throws when a placeholder has no constant', () => {
    const dir = fixtureDir({skill: skillWith('Use {{NOPE}} here.')});
    expect(() => renderSkill({dir, constants: {}})).toThrow(/NOPE/);
  });
  it('throws when a constant is never used', () => {
    const dir = fixtureDir({skill: skillWith('No placeholders.')});
    expect(() => renderSkill({dir, constants: {UNUSED: 1}})).toThrow(/UNUSED/);
  });
  it('fills a placeholder from the injected constants', () => {
    const dir = fixtureDir({skill: skillWith('Under {{N}} rows.')});
    expect(renderSkill({dir, constants: {N: 7}})).toContain('Under 7 rows.');
  });
  it('the text carries the code constant in BI-13 and BI-34', () => {
    expect(SKILL_CONSTANTS.SMALL_SAMPLE_N).toBe(SMALL_SAMPLE_N);
    for (const id of ['BI-13', 'BI-34']) {
      const line = text.split('\n').find((l) => l.includes(`[${id} ⚙]`)) ?? '';
      expect(line).toContain(`${SMALL_SAMPLE_N} rows`);
    }
  });
});

describe('size and caching', () => {
  it('fits the token budget (4,830)', () => {
    const tokens = estimateTokens(text);
    console.log(`rendered skill: ${text.length} characters, about ${tokens} tokens`);
    expect(tokens).toBeLessThan(4830);
  });
  it('renderSkill is identical across calls', () => {
    expect(renderSkill()).toBe(renderSkill());
    expect(renderSkill({explore: true})).toBe(renderSkill({explore: true}));
  });
  it('the non-explore render is byte-identical to the pre-Explore text', () => {
    expect(createHash('sha256').update(text).digest('hex')).toBe(BASELINE_SHA256);
  });
  // Train 2 (2026-10-07): +EXP-07, EXP-08 and the EXP-04 label rule (explore only).
  // Train 3 (2026-10-07): +EXP-09..11, PAGE-01, the base-table stock bullet. Budgets were 4,500 and 6,600; measured 4,597 and 6,861, plus 5%.
  it('the explore variant fits its budget (7,210) and puts sql-explore after dashboard-composition', () => {
    const tokens = estimateTokens(exploreText);
    console.log(`explore skill: ${exploreText.length} characters, about ${tokens} tokens`);
    expect(tokens).toBeLessThan(7210);
    expect(exploreText.indexOf('## Topic: dashboard-composition')).toBeGreaterThan(-1);
    expect(exploreText.indexOf('## Topic: dashboard-composition')).toBeLessThan(exploreText.indexOf('## Topic: sql-explore'));
    expect([...EXPLORE_TOPICS]).toEqual(['sql-explore']);
  });
  it('the non-explore text never promises the Explore tool', () => {
    expect(text).not.toMatch(/run_query|sql-explore|Exploratory/);
  });
  it('buildStaticSystem is byte-identical across calls and carries the whole skill', () => {
    const a = buildStaticSystem();
    expect(buildStaticSystem()).toBe(a);
    expect(a).toContain(text);
    expect(a).toContain('## How you think');
    for (const t of SKILL_TOPICS) expect(a).toContain(`## Topic: ${t} (`);
  });
});

describe('scope: F9 content does not leak in early', () => {
  it.each(['Save report', 'DASH-03', 'DASH-06', 'DASH-07'])('no "%s" in the rendered skill', (word) => {
    expect(text).not.toContain(word);
  });
  it('F8 content is present: editing the open dashboard', () => {
    for (const word of ['DASH-09', 'DASH-10', 'DASH-11', 'set_report_filters', 'remove_block']) expect(text).toContain(word);
  });
  it('F7 content is present: tiles, the chart tool, orientation and the topics', () => {
    for (const word of ['KPI', 'render_chart', 'orientation', 'render_table', 'render_kpi']) expect(text).toContain(word);
  });
  it('the constants in the text come from recommend-view', () => {
    expect(SKILL_CONSTANTS).toMatchObject({KPI_MAX, PIE_MAX_SEGMENTS, TABLE_MIN_CLASSES, SERIES_FOLD_AT});
    expect(text).toContain(`up to ${KPI_MAX} `);
    expect(text).toContain(`At most ${PIE_MAX_SEGMENTS} slices`);
  });
  it('the topic order is the documented one', () => {
    expect([...SKILL_TOPICS]).toEqual(['bi-reconciliation', 'period-comparison', 'allocation-and-prices', 'data-quality', 'viz-forms', 'dashboard-composition', 'page-context']);
  });
});

describe('frontmatter follows the Agent Skills rules', () => {
  const raw = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1].trim() ?? '';
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1].trim() ?? '';
  it('name', () => {
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/claude|anthropic/);
  });
  it('description', () => {
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
  it('the frontmatter is stripped from the prompt text', () => {
    expect(text).not.toMatch(/^---$/m);
    expect(text.split('\n')[0]).toContain(`(${name})`);
  });
});

describe('the two rules that replaced the F5 stopgaps', () => {
  it('ANL-04 (number words) and BI-08 (cut list) are present with their ids', () => {
    expect(text).toMatch(/\[ANL-04\] .*two thirds/);
    expect(text).toMatch(/\[BI-08 ⚙\] When a list is cut .*Showing the first N of M.*among these/);
  });
});

describe('what must never be inside the prompt', () => {
  const text = renderSkill();

  it('contains no production-derived figures (a prompt gets parroted, and the data changes)', () => {
    for (const figure of ['106,950', '147,300', '40,350', '71,050', '18,050', '17,850', '139,360', '32,410', '23.3', '66.4', '16.9', '16.7', '11,822', '99,250']) {
      expect(text, `figure ${figure} must not appear in the skill`).not.toContain(figure);
    }
  });

  it('never has Coop claim an action it cannot take (logged, saved, reported, sent)', () => {
    expect(text).not.toMatch(/\bthe team gets it logged\b|\bI('ve| have) (logged|saved|reported|sent|notified)\b/i);
    expect(text).toMatch(/never say you logged, saved or reported anything/i);
  });
});

describe('every rule enforced by code has a test titled with its id', () => {
  const titles = (): string[] => {
    return ['test/skill-rules-enforced.test.ts', 'test/skill-rules-viz.test.ts'].flatMap((file) => {
      const src = readFileSync(path.join(process.cwd(), file), 'utf8');
      return [...src.matchAll(/\bit\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    });
  };
  // The EXP-* code rules are covered by test/chat-explore-*.test.ts (A and the Integrator; chat-explore-rules.test.ts checks them).
  const codeIds = RULES.filter((r) => r.enforcedBy === 'code' && !r.id.startsWith('EXP-')).map((r) => r.id);

  it('finds a test whose title starts with "<ID>: " for every ⚙ rule, and none for a guide-only rule', () => {
    const t = titles();
    const missing = codeIds.filter((id) => !t.some((title) => title.startsWith(`${id}: `)));
    expect(missing, `⚙ rules without a test: ${missing.join(', ')}`).toEqual([]);
    const guideWithTest = RULES.filter((r) => r.enforcedBy === 'guide' && t.some((title) => title.startsWith(`${r.id}: `))).map((r) => r.id);
    expect(guideWithTest, 'a guide-only rule must not claim a code test').toEqual([]);
  });

  it('the finder really fails when a test title is missing (the gate can fail)', () => {
    const fake = ["BI-02: parts add up", "BI-04: round rows"];
    const missing = codeIds.filter((id) => !fake.some((title) => title.startsWith(`${id}: `)));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('BI-01');
  });
});
