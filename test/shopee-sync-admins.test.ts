import {describe, expect, it} from 'vitest';
import {isSyncAdmin, parseAdmins} from '../src/shopee-sync/admins';
import {normaliseRemoteUrl, parseHosts, remoteBrowserHref} from '../src/shopee-sync/remote';

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
  it('accepts only a plain https address: no credentials, query or fragment; empty clears it', () => {
    expect(normaliseRemoteUrl(' https://browser.example.com/ ')).toEqual({ok: true, url: 'https://browser.example.com'});
    expect(normaliseRemoteUrl('')).toEqual({ok: true, url: null});
    for (const bad of ['http://browser.example.com', 'javascript:alert(1)', 'ftp://x.com', 'browser.example.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f', 'https://' + 'a'.repeat(300) + '.com']) {
      expect(normaliseRemoteUrl(bad)).toMatchObject({ok: false});
    }
  });
});

describe('SHOPEE_SYNC_REMOTE_HOSTS', () => {
  it('is a comma list of hosts, lower-cased', () => {
    expect(parseHosts(' Browser.Example.com, b.example.com ,,')).toEqual(['browser.example.com', 'b.example.com']);
    expect(parseHosts(undefined)).toEqual([]);
  });
  it('when set, the address host must be one of them (exact, case-insensitive); when unset any https host passes', () => {
    const hosts = ['browser.example.com'];
    expect(normaliseRemoteUrl('https://Browser.example.com/', hosts)).toEqual({ok: true, url: 'https://browser.example.com'});
    for (const bad of ['https://browser.example.com.evil.com', 'https://evil.com', 'https://xbrowser.example.com', 'https://browser.example.com@evil.com']) expect(normaliseRemoteUrl(bad, hosts)).toMatchObject({ok: false});
    expect(normaliseRemoteUrl('https://anything.example.org')).toMatchObject({ok: true});
  });
});
