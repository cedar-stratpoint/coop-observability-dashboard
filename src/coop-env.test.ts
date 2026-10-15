import {describe, expect, it} from 'vitest';
import {COOP_ENVS, dbRefOf, envForHost, guardEnvKey, prodConfirmOk, resolveEnv, switchHref} from './coop-env';

describe('coop environments', () => {
  it('has exactly Staging and Production', () => {
    expect(COOP_ENVS.map((e) => e.key)).toEqual(['staging', 'production']);
  });

  it('recognises production only by its own host; everything else is Staging', () => {
    expect(envForHost('coop-brand-os.vercel.app').key).toBe('production');
    expect(envForHost('COOP-BRAND-OS.vercel.app:443').key).toBe('production');
    expect(envForHost('coop-brand-os-staging.vercel.app').key).toBe('staging');
    expect(envForHost('localhost:3000').key).toBe('staging');
    expect(envForHost('coop-brand-os-git-feat-x.vercel.app').key).toBe('staging'); // previews read Staging
    expect(envForHost(null).key).toBe('staging');
    expect(envForHost('evil.coop-brand-os.vercel.app').key).toBe('staging');
  });

  it('links to the same page on the other environment', () => {
    expect(switchHref('production', '/stock', '?store=1')).toBe('https://coop-brand-os.vercel.app/stock?store=1');
    expect(switchHref('staging', 'admin/users', 'q=a', 'x')).toBe('https://coop-brand-os-staging.vercel.app/admin/users?q=a#x');
    expect(switchHref('production', '/')).toBe('https://coop-brand-os.vercel.app/');
  });

  it('requires typing PRODUCTION only in production', () => {
    expect(prodConfirmOk('staging', undefined)).toBe(true);
    expect(prodConfirmOk('production', undefined)).toBe(false);
    expect(prodConfirmOk('production', 'production')).toBe(false);
    expect(prodConfirmOk('production', ' PRODUCTION ')).toBe(true);
  });
});

describe('environment from the database (not the address)', () => {
  const STG = 'https://syxwixxzmytvhwhkwdvw.supabase.co';
  const PROD = 'https://qkxbwzdxhwcbwgriwipi.supabase.co';
  it('reads the project ref from the database URL', () => {
    expect(dbRefOf(PROD)).toBe('qkxbwzdxhwcbwgriwipi');
    expect(dbRefOf('not a url')).toBeNull();
    expect(dbRefOf(undefined)).toBeNull();
  });
  it('the database decides, whatever host the site was reached on', () => {
    expect(resolveEnv(PROD, 'coop-brand-os-abc123-team.vercel.app').key).toBe('production'); // deployment URL
    expect(resolveEnv(PROD, 'coop.example.com').key).toBe('production'); // custom domain
    expect(resolveEnv(STG, 'coop-brand-os.vercel.app').key).toBe('staging'); // the known staging-pointing-wrong case is labelled by data
  });
  it('falls back to the host only for an unknown database (label only)', () => {
    expect(resolveEnv(undefined, 'coop-brand-os.vercel.app').key).toBe('production');
    expect(resolveEnv('https://other.supabase.co', 'localhost:3000').key).toBe('staging');
  });
  it('the safety guard fails closed: only the Staging database counts as Staging', () => {
    expect(guardEnvKey(STG)).toBe('staging');
    expect(guardEnvKey(PROD)).toBe('production');
    expect(guardEnvKey(undefined)).toBe('production');
    expect(guardEnvKey('https://other.supabase.co')).toBe('production');
  });
  it('uses the first value of a forwarded host list', () => {
    expect(envForHost('coop-brand-os.vercel.app, proxy.internal').key).toBe('production');
  });
});
