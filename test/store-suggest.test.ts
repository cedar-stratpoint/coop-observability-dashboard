import {describe, expect, it} from 'vitest';
import {suggestStore} from '../src/store-suggest';

// Real registry names (truncated to 20 characters, as stored).
const STORES = [
  {code: '95', name: 'DAVAO'},
  {code: '854', name: 'GAISANO-DAVAO 2'},
  {code: '75', name: 'SM CITY-DAVAO 1'},
  {code: '2166', name: 'GMALL OF DIGOS'},
  {code: '1040', name: 'GAISANO - ILIGAN'},
  {code: '1027', name: 'GAISANO - TAGUM CITY'},
  {code: '1233', name: 'GAISANO BUKIDNON'},
  {code: '2946', name: 'GAISANO COUNTRY MALL'},
  {code: '473', name: 'SM CITY-SAN PABLO 1'},
];

describe('suggestStore', () => {
  it('a rare word picks the one store that has it', () => {
    expect(suggestStore('W. Gaisano Mall Digos', STORES)).toBe('2166');
    expect(suggestStore('Watsons SM San Pablo', STORES)).toBe('473');
    expect(suggestStore('GMALL DILIOS ELIEW', STORES)).toBe('2166'); // a misread of GMALL OF DIGOS
  });
  it('common words and ties suggest nothing', () => {
    expect(suggestStore('Watsons Mall Cicero Davao', STORES)).toBeNull(); // three Davao stores
    expect(suggestStore('Gaisano Mall', STORES)).toBeNull(); // Gaisano is in five
    expect(suggestStore(null, STORES)).toBeNull();
    expect(suggestStore('Store not readable 654', STORES)).toBeNull();
  });
});
