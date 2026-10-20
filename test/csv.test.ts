import {describe, expect, it} from 'vitest';
import {csvCell, toCsv} from '../src/csv';

// One CSV writer for the CRM page and the chat's contact tables. Rows carry customer-typed text, so a cell that starts with
// = + - @ (or a tab or carriage return) could run as a spreadsheet formula: it is prefixed with a quote.
describe('csvCell', () => {
  it('leaves a plain value alone and writes null and undefined as empty', () => {
    expect(csvCell('mimi@example.com')).toBe('mimi@example.com');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
  });
  it('quotes a value with a comma, a quote or a line break, and doubles inner quotes', () => {
    expect(csvCell('Mimi, Puspin')).toBe('"Mimi, Puspin"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('defuses formulas: = + - @ tab and carriage return at the start get a leading quote', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) expect(csvCell(`${lead}cmd|calc`)).toMatch(/^"?'/);
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });
  it('does not touch a value that merely contains those characters later', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('09171234567')).toBe('09171234567');
  });
});

describe('toCsv', () => {
  it('writes rows with a newline between them and no trailing newline', () => {
    expect(toCsv([['email', 'pet'], ['a@x.com', 'Mimi, cat']])).toBe('email,pet\na@x.com,"Mimi, cat"');
  });
});
