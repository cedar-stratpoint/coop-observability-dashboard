import {describe, expect, it} from 'vitest';
import {instagramUrl} from '../src/instagram';

describe('instagramUrl', () => {
  it('links a typed handle, with or without @', () => {
    expect(instagramUrl('@Karla.Sy')).toBe('https://www.instagram.com/karla.sy/');
    expect(instagramUrl('the_va_ltracks')).toBe('https://www.instagram.com/the_va_ltracks/');
  });
  it('refuses anything that is not a handle (no URLs, spaces or scripts)', () => {
    for (const bad of [null, '', '@', 'karla sy', 'javascript:alert(1)', 'https://evil.example', 'a'.repeat(31)]) expect(instagramUrl(bad)).toBeNull();
  });
});
