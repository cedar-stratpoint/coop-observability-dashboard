import {describe, expect, it} from 'vitest';
import {planServerScans} from '../components/analyst/server-scan-plan';

describe('planServerScans', () => {
  it('reads one PDF as one server scan with the typed name', () => {
    expect(planServerScans([{name: 'Scan.pdf'}], true, '  Oct 16 to 31 ')).toEqual({kind: 'server', scans: [{index: 1, total: 1, name: 'Oct 16 to 31'}]});
  });
  it('reads several PDFs as separate server scans, naming each part', () => {
    expect(planServerScans([{name: 'a.PDF'}, {name: 'b.pdf'}], true, 'Oct 16 to 31')).toEqual({
      kind: 'server',
      scans: [
        {index: 1, total: 2, name: 'Oct 16 to 31 · part 1'},
        {index: 2, total: 2, name: 'Oct 16 to 31 · part 2'},
      ],
    });
  });
  it('leaves the name empty when none was typed', () => {
    const plan = planServerScans([{name: 'a.pdf'}, {name: 'b.pdf'}], true, '');
    expect(plan.kind === 'server' && plan.scans.map((s) => s.name)).toEqual([undefined, undefined]);
  });
  it('keeps mixed drops and the flag-off case on the client path', () => {
    expect(planServerScans([{name: 'a.pdf'}, {name: 'sales.csv'}], true, 'x')).toEqual({kind: 'client'});
    expect(planServerScans([{name: 'a.pdf'}], false, 'x')).toEqual({kind: 'client'});
    expect(planServerScans([], true, 'x')).toEqual({kind: 'client'});
  });
});
