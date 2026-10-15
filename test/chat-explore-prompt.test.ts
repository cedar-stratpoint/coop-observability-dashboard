// The explore skill is runtime product content for the model: no real figures, no claim of an action the app lacks.
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {renderSkill} from '../src/chat/skills/load';
import {buildDataIndexText} from '../src/chat/catalog/prompt';
import {buildExamplesText} from '../src/chat/explore/examples';

const FORBIDDEN_FIGURES = ['106,950', '147,300', '40,350', '71,050', '18,050', '17,850', '139,360', '32,410', '23.3', '66.4', '16.9', '16.7', '11,822', '99,250'];
const REAL_NAMES = ['SM Aura', 'Circuit Makati', 'Modern Market', 'Salmon Bites', 'Chicken Jerky'];
const explore = renderSkill({explore: true});

describe('the rendered explore skill', () => {
  it('contains no production-derived figure and no real event or product name', () => {
    for (const f of FORBIDDEN_FIGURES) expect(explore, f).not.toContain(f);
    for (const n of REAL_NAMES) expect(explore, n).not.toContain(n);
  });
  it('has Coop claim no action it cannot take', () => {
    expect(explore).not.toMatch(/\bthe team gets it logged\b|\bI('ve| have) (logged|saved|reported|sent|notified)\b/i);
    expect(explore).toMatch(/never say you logged, saved or reported anything/i);
  });
  it('requires the exploratory caveat and the contact-details rule', () => {
    expect(explore).toContain('Exploratory, not a registered metric');
    expect(explore).toContain('email, phone, instagram');
    expect(explore).not.toContain('already masked');
  });
  it('carries the Day 1 lessons', () => {
    expect(explore).toMatch(/ilike/);
    expect(explore).toMatch(/all available data/);
    expect(explore).toMatch(/booth sign-ups, not buyers/);
    expect(explore).toMatch(/date window/);
    expect(explore).toMatch(/null means untagged/);
    expect(explore).toMatch(/voided/);
    expect(explore).toMatch(/Asia\/Manila/);
    expect(explore).toMatch(/bundle pick lines/);
    expect(explore).toMatch(/say which basis/);
  });
});

describe('the cached blocks are deterministic and clean', () => {
  it('the data index and the examples are byte-identical across calls', () => {
    expect(buildDataIndexText()).toBe(buildDataIndexText());
    expect(buildExamplesText()).toBe(buildExamplesText());
  });
  it('they contain no forbidden figure and no first-person action claim', () => {
    for (const t of [buildDataIndexText(), buildExamplesText()]) {
      for (const f of FORBIDDEN_FIGURES) expect(t, f).not.toContain(f);
      expect(t).not.toMatch(/\bI('ve| have) (logged|saved|reported|sent|notified)\b/i);
    }
  });
});
