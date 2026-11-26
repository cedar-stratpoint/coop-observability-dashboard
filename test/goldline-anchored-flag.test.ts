import {afterEach, describe, expect, it, vi} from 'vitest';
import {baHintEnabled, headerCropsEnabled, templateReadEnabled} from '../src/goldline-anchored-flag';
import {HEADER_CROP_FRAC, HEADER_CROPS_NOTE} from '../src/goldline-page-bands';

describe('templateReadEnabled', () => {
  const prev = process.env.GOLDLINE_TEMPLATE_READ_COMPANIES;
  afterEach(() => {
    if (prev === undefined) delete process.env.GOLDLINE_TEMPLATE_READ_COMPANIES;
    else process.env.GOLDLINE_TEMPLATE_READ_COMPANIES = prev;
  });

  it('is off by default (fail-closed) and for an empty company id', () => {
    delete process.env.GOLDLINE_TEMPLATE_READ_COMPANIES;
    expect(templateReadEnabled('goldline')).toBe(false);
    process.env.GOLDLINE_TEMPLATE_READ_COMPANIES = 'goldline';
    expect(templateReadEnabled('')).toBe(false);
  });

  it('is on only for a listed company (exact, case-sensitive, comma list)', () => {
    process.env.GOLDLINE_TEMPLATE_READ_COMPANIES = 'goldline, acme';
    expect(templateReadEnabled('goldline')).toBe(true);
    expect(templateReadEnabled('acme')).toBe(true);
    expect(templateReadEnabled('other')).toBe(false);
    expect(templateReadEnabled('GOLDLINE')).toBe(false);
  });
});

describe('headerCropsEnabled (GOLDLINE_HEADER_CROP_COMPANIES)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is off unless the company is listed', () => {
    vi.stubEnv('GOLDLINE_HEADER_CROP_COMPANIES', '');
    expect(headerCropsEnabled('goldline')).toBe(false);
    vi.stubEnv('GOLDLINE_HEADER_CROP_COMPANIES', 'goldline, other');
    expect(headerCropsEnabled('goldline')).toBe(true);
    expect(headerCropsEnabled('zoomy')).toBe(false);
    expect(headerCropsEnabled('')).toBe(false);
  });
  it('the classify note points the reader at the crops for the header only', () => {
    expect(HEADER_CROPS_NOTE).toMatch(/TOP and BOTTOM/);
    expect(HEADER_CROPS_NOTE).toMatch(/store_code, store_name/);
    expect(HEADER_CROPS_NOTE).toMatch(/whole page as usual/);
    expect(HEADER_CROP_FRAC).toBeGreaterThan(0.08);
    expect(HEADER_CROP_FRAC).toBeLessThan(0.2);
  });
});

describe('baHintEnabled (GOLDLINE_BA_HINT_COMPANIES)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is off unless the company is listed', () => {
    vi.stubEnv('GOLDLINE_BA_HINT_COMPANIES', '');
    expect(baHintEnabled('goldline')).toBe(false);
    vi.stubEnv('GOLDLINE_BA_HINT_COMPANIES', 'goldline');
    expect(baHintEnabled('goldline')).toBe(true);
    expect(baHintEnabled('zoomy')).toBe(false);
  });
});
