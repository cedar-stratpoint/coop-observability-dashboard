import {describe, expect, it} from 'vitest';
import {printedHeader} from '../components/analyst/review-grid-cols';


// QA Nov 26: on a Legacy page the review labels follow how BAs fill the form (Stockroom, Drawer,
// Selling area), so the printed header shows under each label to match the paper.
describe('printedHeader', () => {
  it('names the printed Legacy header under each relabelled column', () => {
    expect(printedHeader('legacy', 'stockroom')).toBe('Beginning Inventory');
    expect(printedHeader('legacy', 'drawer')).toBe('Delivery');
    expect(printedHeader('legacy', 'selling_area')).toBe('Beginning + Delivery');
    expect(printedHeader('legacy', 'ending_on_hand')).toBe('Ending Inventory');
    expect(printedHeader('legacy', 'delivery')).toBeNull();
  });
  it('V1 and V2 labels already match the paper', () => {
    expect(printedHeader('v1', 'stockroom')).toBeNull();
    expect(printedHeader('v2', 'drawer')).toBeNull();
    expect(printedHeader(null, 'stockroom')).toBeNull();
  });
});
