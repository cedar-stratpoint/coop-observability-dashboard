import {describe, expect, it} from 'vitest';
import {LINE_PARTS, PART_LINE_IDS, consistentParts, parsePartsInput, partTargets, sumPesos, validateParts} from '../src/plan-parts';
import {LINES, monthComplete} from '../src/plan-compute';

describe('LINE_PARTS', () => {
  it('covers the three consolidated lines, with the workbook breakdown', () => {
    expect([...PART_LINE_IDS]).toEqual(['overhead', 'cogs', 'content_other']);
    expect(LINE_PARTS.overhead.map((p) => p.id)).toEqual(['salaries', 'rent', 'accounting', 'tech', 'growth_consultant', 'rnd']);
    expect(LINE_PARTS.cogs.map((p) => p.id)).toEqual(['marketplace_cogs', 'website_cogs', 'events_cogs']);
    expect(LINE_PARTS.content_other.map((p) => p.id)).toEqual(['content_socials', 'other_spend']);
  });
  it('only splits lines that are typed lines, and never the single-cell ones', () => {
    for (const id of PART_LINE_IDS) expect(LINES.some((l) => l.id === id)).toBe(true);
    for (const id of ['platform_fees', 'fulfilment', 'event_costs', 'ad_marketplace', 'ad_website']) expect(PART_LINE_IDS).not.toContain(id);
  });
});

describe('sumPesos', () => {
  it('adds in centavos with no float drift', () => {
    expect(sumPesos([0.1, 0.2])).toBe(0.3);
    expect(sumPesos([90000, 15000.1, 15000.2, 4000.05])).toBe(124000.35);
    expect(sumPesos([])).toBe(0);
  });
});

describe('parsePartsInput (typed in PHP thousands, like the grid)', () => {
  it('parses every part to pesos and sums them', () => {
    const r = parsePartsInput('overhead', {salaries: '91', rent: '17', accounting: '13', tech: '4.5', growth_consultant: '9', rnd: '0'});
    expect(r).toEqual({ok: true, parts: {salaries: 91000, rent: 17000, accounting: 13000, tech: 4500, growth_consultant: 9000, rnd: 0}, total: 134500});
  });
  it('a blank part is an error, never a silent 0: type 0 for none', () => {
    const r = parsePartsInput('cogs', {marketplace_cogs: '33.292', website_cogs: '', events_cogs: '  '});
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(Object.keys(r.errors)).toEqual(['website_cogs', 'events_cogs']); expect(r.errors.website_cogs).toMatch(/0/); }
  });
  it('rejects text and negatives per part', () => {
    const r = parsePartsInput('content_other', {content_socials: 'abc', other_spend: '-1'});
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.content_socials).toBe('Enter a number.'); expect(r.errors.other_spend).toMatch(/negative/); }
  });
  it('rounds to centavos', () => {
    const r = parsePartsInput('content_other', {content_socials: '12.3456', other_spend: '5'});
    expect(r).toEqual({ok: true, parts: {content_socials: 12345.6, other_spend: 5000}, total: 17345.6});
  });
});

describe('validateParts (server side)', () => {
  const ok = {content_socials: 7000, other_spend: 5000};
  it('accepts exactly the line parts', () => expect(validateParts('content_other', ok)).toBeNull());
  it('rejects a line without a breakdown, missing, extra, negative and non-finite parts', () => {
    expect(validateParts('platform_fees', ok)).toBe('Unknown line.');
    expect(validateParts('content_other', {content_socials: 1})).toMatch(/every part/i);
    expect(validateParts('content_other', {...ok, extra: 1})).toMatch(/Unknown part/);
    expect(validateParts('content_other', {content_socials: -1, other_spend: 1})).toMatch(/negative/);
    expect(validateParts('content_other', {content_socials: Number.NaN, other_spend: 1})).toMatch(/number/);
    expect(validateParts('content_other', null)).toMatch(/every part/i);
  });
});

describe('consistentParts: parts count only while they still sum to the total', () => {
  const parts = {content_socials: 7000, other_spend: 5000};
  it('matches to the centavo', () => {
    expect(consistentParts('content_other', 12000, parts)).toBe(true);
    expect(consistentParts('content_other', 12000.004, parts)).toBe(true);
  });
  it('is false once the total was typed directly to something else (stale parts), or there are none', () => {
    expect(consistentParts('content_other', 25000, parts)).toBe(false);
    expect(consistentParts('content_other', 12000, undefined)).toBe(false);
    expect(consistentParts('content_other', 12000, {content_socials: 12000})).toBe(false);
  });
});

describe('partTargets: the grey workbook value per part', () => {
  const seed = {content_other: {content_socials: [7000, 7000], other_spend: [5000, 5000]}};
  it('is shown when the parts add up to the line target', () => {
    expect(partTargets('content_other', 0, 12000, seed)).toEqual({content_socials: 7000, other_spend: 5000});
  });
  it('is hidden when the line target is from another plan version (they no longer add up) or unknown', () => {
    expect(partTargets('content_other', 0, 40000, seed)).toBeNull();
    expect(partTargets('content_other', 0, null, seed)).toBeNull();
    expect(partTargets('cogs', 0, 1, seed)).toBeNull();
  });
});

describe('typed semantics: the total is what counts', () => {
  it('a month is complete when every line has a total, however each total was entered', () => {
    const lines = Object.fromEntries(LINES.map((l) => [l.id, [l.id === 'overhead' ? sumPesos([91000, 17000.5]) : 0]]));
    expect(monthComplete(lines, 0)).toBe(true);
  });
});
