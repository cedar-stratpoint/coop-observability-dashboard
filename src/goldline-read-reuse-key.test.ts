import {describe, expect, it} from 'vitest';
import {readReuseKey} from './goldline-read-reuse-key';

describe('readReuseKey', () => {
  it('ties a read to the model and the deployed commit', () => {
    expect(readReuseKey('claude-sonnet-5-5', 'ae4faccaacd1cbc4c9a0749749a610c04867bedf')).toBe('claude-sonnet-5-5@ae4faccaacd1');
  });
  it('is null without a commit (local dev reads are never reused)', () => {
    expect(readReuseKey('claude-sonnet-5-5', undefined)).toBeNull();
    expect(readReuseKey('claude-sonnet-5-5', '  ')).toBeNull();
  });
});
