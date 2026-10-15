import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {extractionConfigured} from './goldline-extract-run';

// Goldline bills to its own Anthropic key. It must never pick up Ask Coop's key.
describe('extractionConfigured', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on when GOLDLINE_ANTHROPIC_API_KEY is set', () => {
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY', 'sk-ant-goldline');
    expect(extractionConfigured()).toBe(true);
  });

  it("does not fall back to Ask Coop's ANTHROPIC_API_KEY", () => {
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-ask-coop');
    expect(extractionConfigured()).toBe(false);
  });
});
