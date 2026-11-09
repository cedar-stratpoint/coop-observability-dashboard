import {describe, expect, it} from 'vitest';
import {serverUploadCompanies, serverUploadEnabled} from '../src/goldline-server-upload';

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
