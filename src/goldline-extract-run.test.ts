import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {extractionConfigured, isKeyLevelError} from './goldline-extract-run';

// Goldline bills to its own Anthropic key. It must never pick up Ask Coop's key.
describe('extractionConfigured', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on when GOLDLINE_ANTHROPIC_API_KEY is set', () => {
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY', 'sk-ant-goldline');
    expect(extractionConfigured()).toBe(true);
  });

  it('is on when only the fallback key is set', () => {
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY', '');
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY_FALLBACK', 'sk-ant-standby');
    expect(extractionConfigured()).toBe(true);
  });

  it("does not fall back to Ask Coop's ANTHROPIC_API_KEY", () => {
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY', '');
    vi.stubEnv('GOLDLINE_ANTHROPIC_API_KEY_FALLBACK', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-ask-coop');
    expect(extractionConfigured()).toBe(false);
  });
});

// Only a KEY-level failure (expired / out of credits / workspace scope) should switch to
// the fallback key; transient and content errors must stay on the same key.
describe('isKeyLevelError', () => {
  it('switches on key / credit / workspace failures', () => {
    expect(isKeyLevelError({status: 401})).toBe(true);
    expect(isKeyLevelError({status: 403})).toBe(true);
    expect(isKeyLevelError(new Error('Your credit balance is too low to access the Anthropic API'))).toBe(true);
    expect(isKeyLevelError(new Error('This API key is not scoped to a workspace'))).toBe(true);
    expect(isKeyLevelError(new Error('authentication_error: invalid x-api-key'))).toBe(true);
  });

  it('does NOT switch on transient or content errors', () => {
    expect(isKeyLevelError({status: 429})).toBe(false);
    expect(isKeyLevelError({status: 529})).toBe(false);
    expect(isKeyLevelError(new Error('overloaded_error'))).toBe(false);
    expect(isKeyLevelError(new Error('Extraction declined: page_mismatch'))).toBe(false);
    expect(isKeyLevelError(new Error('Vision did not return valid JSON'))).toBe(false);
  });
});
