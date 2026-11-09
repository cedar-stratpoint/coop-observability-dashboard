import {describe, expect, it} from 'vitest';
import {pumpSecretOk, serverUploadCompanies, serverUploadEnabled} from '../src/goldline-server-upload';

describe('serverUploadEnabled (per-company flag)', () => {
  it('is false when the env is unset or empty (fail-closed)', () => {
    expect(serverUploadEnabled('nichido', undefined)).toBe(false);
    expect(serverUploadEnabled('nichido', '')).toBe(false);
    expect(serverUploadEnabled('', 'nichido')).toBe(false);
  });
  it('enables only the allow-listed companies, trimming whitespace', () => {
    expect(serverUploadEnabled('nichido', 'nichido')).toBe(true);
    expect(serverUploadEnabled('nichido', ' zoomy , nichido ')).toBe(true);
    expect(serverUploadEnabled('zoomy', 'nichido')).toBe(false);
  });
  it('parses the comma list into a set', () => {
    expect([...serverUploadCompanies('a, b ,,c')].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('pumpSecretOk (read-page route gate)', () => {
  it('matches only an exact, equal-length secret', () => {
    expect(pumpSecretOk('s3cret-token', 's3cret-token')).toBe(true);
    expect(pumpSecretOk('s3cret-token', 's3cret-tokeX')).toBe(false);
    expect(pumpSecretOk('s3cret', 's3cret-token')).toBe(false); // length mismatch
  });
  it('fails closed when either side is missing or empty', () => {
    expect(pumpSecretOk(null, 'x')).toBe(false);
    expect(pumpSecretOk('x', undefined)).toBe(false);
    expect(pumpSecretOk('', '')).toBe(false);
    expect(pumpSecretOk(undefined, undefined)).toBe(false);
  });
});
