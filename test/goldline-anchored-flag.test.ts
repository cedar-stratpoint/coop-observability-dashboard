import {afterEach, describe, expect, it} from 'vitest';
import {templateReadEnabled} from '../src/goldline-anchored-flag';

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
