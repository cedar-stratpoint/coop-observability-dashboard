import {describe, expect, it} from 'vitest';
import {isSyncAdmin, parseAdmins} from '../src/shopee-sync/admins';
import {normaliseRemoteUrl, remoteBrowserHref} from '../src/shopee-sync/remote';

describe('SHOPEE_SYNC_ADMINS', () => {
  it('is a comma list, trimmed and lower-cased; empty or unset means nobody', () => {
    expect(parseAdmins(' A@x.com, b@X.com ,,')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseAdmins(undefined)).toEqual([]);
    expect(parseAdmins('')).toEqual([]);
  });
  it('matches an email case-insensitively and never matches when unset', () => {
    expect(isSyncAdmin('A@X.com', 'a@x.com,b@x.com')).toBe(true);
    expect(isSyncAdmin('c@x.com', 'a@x.com')).toBe(false);
    expect(isSyncAdmin('a@x.com', undefined)).toBe(false);
  });
});

describe('remote browser link', () => {
  it('opens noVNC straight into the session and reconnects', () => {
    expect(remoteBrowserHref('https://browser.example.com')).toBe('https://browser.example.com/vnc.html#autoconnect=1&reconnect=1&resize=remote');
    expect(remoteBrowserHref('https://browser.example.com/')).toBe('https://browser.example.com/vnc.html#autoconnect=1&reconnect=1&resize=remote');
  });
  it('accepts only a plain http(s) address: no credentials, query or fragment; empty clears it', () => {
    expect(normaliseRemoteUrl(' https://browser.example.com/ ')).toEqual({ok: true, url: 'https://browser.example.com'});
    expect(normaliseRemoteUrl('')).toEqual({ok: true, url: null});
    for (const bad of ['javascript:alert(1)', 'ftp://x.com', 'browser.example.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f', 'https://' + 'a'.repeat(300) + '.com']) {
      expect(normaliseRemoteUrl(bad)).toMatchObject({ok: false});
    }
  });
});
