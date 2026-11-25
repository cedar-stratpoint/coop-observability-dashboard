import {describe, expect, it} from 'vitest';
import {anthropicClientOptions} from '../src/chat/anthropic-client';
import {describeChatEnv} from '../src/chat/health';

describe('anthropicClientOptions (Ask Coop Claude client)', () => {
  it('returns null without a key, so the route answers "not configured"', () => {
    expect(anthropicClientOptions({})).toBeNull();
    expect(anthropicClientOptions({ANTHROPIC_API_KEY: '   '})).toBeNull();
  });

  it('a workspace-scoped key: no workspace header', () => {
    expect(anthropicClientOptions({ANTHROPIC_API_KEY: 'sk-ant-x'})).toEqual({apiKey: 'sk-ant-x'});
    expect(anthropicClientOptions({ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_WORKSPACE_ID: '  '})).toEqual({apiKey: 'sk-ant-x'});
  });

  it('an org-scoped key: sends the workspace in the anthropic-workspace-id header, trimmed', () => {
    expect(anthropicClientOptions({ANTHROPIC_API_KEY: ' sk-ant-x ', ANTHROPIC_WORKSPACE_ID: ' wrkspc_123 '})).toEqual({
      apiKey: 'sk-ant-x',
      defaultHeaders: {'anthropic-workspace-id': 'wrkspc_123'},
    });
  });

  it('the health check reports whether a workspace id is set, never its value', () => {
    const d = describeChatEnv({ANTHROPIC_API_KEY: 'x', ANTHROPIC_WORKSPACE_ID: 'wrkspc_secretish'});
    expect(d.ANTHROPIC_WORKSPACE_ID).toEqual({set: true});
    expect(JSON.stringify(d)).not.toContain('wrkspc_secretish');
  });
});
