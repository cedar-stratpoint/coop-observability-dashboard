import {describe, it, expect} from 'vitest';
import {classifyUpload, MAX_UPLOAD_BYTES} from './goldline-upload';

describe('classifyUpload', () => {
  it('accepts a .csv as pos_csv', () => {
    expect(classifyUpload('sales.csv', 'text/csv', 100)).toEqual({
      ok: true,
      kind: 'pos_csv',
      contentType: 'text/csv',
    });
  });

  it('accepts a .pdf as inventory_pdf', () => {
    expect(classifyUpload('1.pdf', 'application/pdf', 5000)).toEqual({
      ok: true,
      kind: 'inventory_pdf',
      contentType: 'application/pdf',
    });
  });

  it('accepts when the browser sends no MIME (extension is authoritative)', () => {
    expect(classifyUpload('export.CSV', '', 10).ok).toBe(true);
    expect(classifyUpload('scan.PDF', '', 10).ok).toBe(true);
  });

  it('rejects an unsupported extension', () => {
    const r = classifyUpload('photo.png', 'image/png', 10);
    expect(r.ok).toBe(false);
  });

  it('rejects a file with no extension', () => {
    expect(classifyUpload('README', '', 10).ok).toBe(false);
  });

  it('rejects a mislabeled file whose MIME contradicts the extension', () => {
    expect(classifyUpload('sales.csv', 'application/pdf', 10).ok).toBe(false);
    expect(classifyUpload('scan.pdf', 'text/csv', 10).ok).toBe(false);
  });

  it('rejects empty and oversized files', () => {
    expect(classifyUpload('sales.csv', 'text/csv', 0).ok).toBe(false);
    expect(classifyUpload('sales.csv', 'text/csv', MAX_UPLOAD_BYTES + 1).ok).toBe(false);
  });
});
