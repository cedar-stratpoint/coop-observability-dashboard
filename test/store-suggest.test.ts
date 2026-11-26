import {describe, expect, it} from 'vitest';
import {suggestStore, wordMatches} from '../src/store-suggest';

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

// Fuzzy matching (staging 65-page run, Nov 26). Real registry names, cut to 20 characters.
describe('suggestStore: handwriting against cut and abbreviated registry names', () => {
  const REG = [
    {code: '1334', name: 'ROBINSONS PLACE MALO'},
    {code: '1391', name: 'ROB PLACE SANTIAGO I'},
    {code: '296', name: 'MARIA CRISTINA ROSIT'},
    {code: '1296', name: 'DS CABANATUAN'},
    {code: '1209', name: 'WALTERMART STA. MARI'},
    {code: '473', name: 'SM CITY-SAN PABLO 1'},
    {code: '2081', name: 'DSSAN PABLO2'},
    {code: '1027', name: 'GAISANO - TAGUM CITY'},
    {code: '1040', name: 'GAISANO - ILIGAN'},
    {code: '1233', name: 'GAISANO BUKIDNON'},
    {code: '2946', name: 'GAISANO COUNTRY MALL'},
    {code: '284', name: 'SM CITY - BAGUIO MAL'},
    {code: '2414', name: 'SM CENTER PULILAN'},
    {code: '250', name: 'SM CENTER VALENZUELA'},
    {code: '316', name: 'SM CITY-GENERAL SANT'},
    {code: '1303', name: 'KCC VERANZA MALL GEN'},
    // Waltermart is a common word in the real registry (10+ stores), as here.
    {code: '257', name: 'WALTERMART GAPAN'},
    {code: '1217', name: 'WALTERMART DASMA'},
    {code: '1216', name: 'WALTERMART PLARIDEL'},
  ];
  it('a cut registry word matches the start of the written word', () => {
    expect(suggestStore('Rob Malolos', REG)).toBe('1334'); // was ROB PLACE SANTIAGO by the word "rob"
    expect(suggestStore('Watsons Pob. Malolos', REG)).toBe('1334');
    expect(suggestStore('Watsons Veranda Gencan', REG)).toBe('1303');
  });
  it('abbreviations and spelling slips', () => {
    expect(suggestStore('MA. CHRISTINA ROCITAS KAROON FUSHIOTO', REG)).toBe('296');
    expect(suggestStore('Watsons CN Center Pulilan', REG)).toBe('2414');
  });
  it('stays strict where fuzzy would mislead', () => {
    expect(suggestStore('SM Sta Rosa DS', REG)).toBeNull(); // "Santa" is not the cut "SANT" of General Santos
    expect(suggestStore('SM Sta Maria', REG)).toBeNull(); // was Maria Cristina; Waltermart Sta. Maria ties
    expect(suggestStore('Waltermart Mall Binondo Bagumbayan', REG)).toBeNull(); // "TAGUM" isn't cut (CITY is last)
    expect(suggestStore('Watsons SM San Pablo', REG)).toBe('473'); // PABLO2 is another branch, exact only
    expect(suggestStore('Malolos', REG)).toBe('1334'); // the 3-letter cut "MAL" of BAGUIO MAL never matches
  });
  it('wordMatches', () => {
    expect(wordMatches('malolos', 'malo', true)).toBe(true);
    expect(wordMatches('malolos', 'malo', false)).toBe(false);
    expect(wordMatches('rocitas', 'rosit', true)).toBe(true);
    expect(wordMatches('christina', 'cristina')).toBe(true);
    expect(wordMatches('pablo', 'pablo2')).toBe(false);
    expect(wordMatches('malolos', 'mal', true)).toBe(false);
  });
});
