import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// Owner rule 4: "a pie is a pie, not a donut". The slices are proven elsewhere (chat-blocks-format "pieSlices ...", chat-recommend-view
// "explicit pie ..."). What draws the hole is the `innerRadius` prop of the recharts <Pie> in components/analyst/chat-charts.tsx.
// Recharts cannot be measured in the node test environment (its container needs a real size), so this is a source-level check of the
// one place the shape is decided. If PiePlot is moved or renamed the test fails loudly rather than passing vacuously.

const SRC = readFileSync('components/analyst/chat-charts.tsx', 'utf8');
const plot = (name: string): string => {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `function ${name} exists`).toBeGreaterThanOrEqual(0);
  const next = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
};

describe('a requested pie renders as a real pie (no centre hole)', () => {
  const pie = plot('PiePlot');

  it('PiePlot draws one recharts <Pie> with innerRadius 0', () => {
    const tags = pie.match(/<Pie\b[^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/\binnerRadius=\{0\}/);
  });

  it('there is no other inner radius in the file, in any form (number, percent string, variable)', () => {
    const all = SRC.match(/innerRadius\s*=\s*(\{[^}]*\}|"[^"]*")/g) ?? [];
    expect(all).toEqual(['innerRadius={0}']);
    expect(SRC).not.toMatch(/innerRadius\s*:/);
  });

  it('nothing in PiePlot draws a hole another way (a donut label, a second concentric Pie, a centre cover)', () => {
    expect(pie.match(/<Pie\b/g)).toHaveLength(1);
    expect(pie).not.toMatch(/<Label\b|<circle|<Customized\b|centerLabel/i);
  });

  it('the pie form is routed to PiePlot, and only the pie form', () => {
    expect(SRC).toMatch(/form === 'pie' \? <PiePlot block=\{drawn\} aria=\{aria\} \/>/);
    expect(SRC.match(/<PiePlot\b/g)).toHaveLength(1);
  });
});
