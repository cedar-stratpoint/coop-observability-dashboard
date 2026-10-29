import {describe, expect, it} from 'vitest';
import {remoteBrowserHref, remoteUrlFromEnv} from '../src/shopee-sync/remote';

// SHOPEE_SYNC_REMOTE_URL is the only way to point the admin link; there is no setting screen or action any more.
describe('remoteUrlFromEnv', () => {
  it('accepts an https address and drops the trailing slash', () => {
    expect(remoteUrlFromEnv(' https://browser.example.com/ ', undefined)).toBe('https://browser.example.com');
  });
  it('is null when unset or empty', () => {
    expect(remoteUrlFromEnv(undefined, undefined)).toBeNull();
    expect(remoteUrlFromEnv('  ', undefined)).toBeNull();
  });
  it('refuses http, other schemes, credentials, query and fragment: the link is where the Shopee password is typed', () => {
    for (const bad of ['http://browser.example.com', 'javascript:alert(1)', 'https://u:p@browser.example.com', 'https://browser.example.com/?a=1', 'https://browser.example.com/#x', 'not a url']) expect(remoteUrlFromEnv(bad, undefined)).toBeNull();
  });
  it('honours the SHOPEE_SYNC_REMOTE_HOSTS allowlist when set', () => {
    expect(remoteUrlFromEnv('https://lookalike.example.com', 'browser.example.com')).toBeNull();
    expect(remoteUrlFromEnv('https://Browser.example.com', ' Browser.Example.com , other.example.com')).toBe('https://browser.example.com');
  });
  it('builds the noVNC link with options in the fragment, which is never sent to a server', () => {
    expect(remoteBrowserHref('https://browser.example.com')).toBe('https://browser.example.com/vnc.html#autoconnect=1&reconnect=1&resize=remote');
  });
});
