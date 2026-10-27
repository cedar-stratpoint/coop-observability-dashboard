import {describe, expect, it} from 'vitest';
import {titleName} from '../src/goldline-ui';

describe('titleName', () => {
  it('turns Watsons capitals into title case, keeping SM and DS', () => {
    expect(titleName('SM MALL OF ASIA 7')).toBe('SM Mall of Asia 7');
    expect(titleName('SM CITY-MARILAO 1')).toBe('SM City-Marilao 1');
    expect(titleName('DS GRAND CENTRAL2')).toBe('DS Grand Central2');
    expect(titleName('MARKET! MARKET!')).toBe('Market! Market!');
    expect(titleName('OF COURSE')).toBe('Of Course');
  });
  it('leaves names that already have lower case alone', () => {
    expect(titleName('Store 123')).toBe('Store 123');
  });
});
