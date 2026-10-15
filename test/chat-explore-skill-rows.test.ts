// D3 (live Ask Coop G01): the model hard-coded `pet not ilike '%ignore%'` after seeing a hostile lead value and told the owner it excluded
// "a lead with strange text". Static check that the guide forbids silent row filtering and demands the criterion, the count and an
// honest "instruction-like text, ignored as data" note. EXP-06 is a guide rule, so this is a content test, not an enforcement test.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const topic = readFileSync('src/chat/skills/ask-coop-data-analyst/topics/sql-explore.md', 'utf8');

describe('EXP-06 never filters rows because their text looks like an instruction', () => {
  it('forbids dropping rows for instruction-like text and says row text is data', () => {
    expect(topic).toMatch(/never (silently )?(drop|exclude|filter)[^.]*(look|looks)[^.]*instruction/i);
    expect(topic).toMatch(/row text is data/i);
  });
  it('requires the exact criterion and the count whenever rows are excluded', () => {
    expect(topic).toMatch(/exact criterion and the (number|count) excluded/i);
  });
  it('says instruction-like text is reported as data, in which field, and not acted on', () => {
    expect(topic).toMatch(/instruction-like text in (the )?field/i);
    expect(topic).toMatch(/ignored it as data/i);
  });
});

// Live test 3 (G25): the SQL split the pet text on "/" and lowercased it, so a hostile value landed in a "no breed given" bucket and the owner
// never learned a row held instruction-like text. Normalising must leave the odd rows visible, with a count and a reason.
describe('EXP-06 normalising free text never folds odd values into an everyday bucket', () => {
  it('names the fields it covers and forbids folding unparseable values into a "no breed given" or "other" bucket', () => {
    expect(topic).toMatch(/normalis(e|ing)[^.]*(pet|prize|handle)/i);
    expect(topic).toMatch(/never fold[^.]*(unparseable|odd)[^.]*(no breed given|other)/i);
  });
  it('lists the rows that cannot be parsed separately, with a count and the reason', () => {
    expect(topic).toMatch(/list[^.]*rows that cannot be parsed[^.]*(separately|own line)[^.]*count[^.]*reason/i);
  });
  it('still reports instruction-like text as data in its field', () => {
    expect(topic).toMatch(/instruction-like text in field/i);
  });
});

// Live test 3: the model typed its own markdown table and no chart, chip or caveats appeared. The app now draws the final result.
describe('guide: the app draws the final result, the model explains it', () => {
  it('says the app draws the final result and the model must not retype it as a markdown table', () => {
    expect(topic).toMatch(/the app draws the final result/i);
    expect(topic).toMatch(/do not retype[^.]*markdown table/i);
    expect(topic).toMatch(/2 to 3 sentences/i);
  });
});

// Live test 4 (G01): the model summed two spellings of one event in its head ("6 orders", true 7) and typed per-event totals that were no cell.
describe('EXP-04/06 no mental arithmetic: merge and total in the SQL, quote cells', () => {
  it('forbids adding, merging, rounding or totalling figures in prose', () => {
    expect(topic).toMatch(/never add, merge, round or total figures in prose/i);
    expect(topic).toMatch(/every figure you write must be a cell/i);
  });
  it('merges spellings of one event in the SQL with lower(btrim()) and sum(), and returns totals as cells', () => {
    expect(topic).toMatch(/`group by` with `sum\(\.\.\.\)`/i);
    expect(topic).toMatch(/per-group and grand totals as columns or rows/i);
    expect(topic).toMatch(/if the owner asks for a total, query the total/i);
  });
  it('no longer says to show two spellings as two rows', () => {
    expect(topic).not.toMatch(/two spellings of one event are two rows/i);
  });
});

// Live test 5 (G01) and final review (A7): one event label per event, never split across pets, proper-case. ONE rule in EXP-06 (EXP-04 points to it).
const LABEL = /min\(min\(btrim\(e\.name\) collate "C"\)\) over \(partition by lower\(btrim\(e\.name\)\)\) as event/;
describe('EXP-04/06 one label rule for event names', () => {
  it('EXP-06 says group by lower(btrim(e.name)) and label with min(min(... collate "C")) over the same partition', () => {
    expect(topic).toMatch(/group by lower\(btrim\(e\.name\)\)/);
    expect(topic).toMatch(LABEL);
  });
  it('EXP-04 points to the EXP-06 rule instead of stating its own', () => {
    const exp04 = topic.split('\n').find((l) => l.startsWith('[EXP-04'))!;
    expect(exp04).toMatch(/EXP-06/);
    expect(exp04).not.toMatch(/min\(btrim|never the lower-cased key/);
  });
  it('no line teaches lower() as the label or the old min(btrim(name)) label', () => {
    expect(topic).not.toMatch(/lower\(btrim\(e\.name\)\) as event/);
    expect(topic).not.toMatch(/never `min\(\)`/);
  });
  it('EXP-06 tells the model to select the venue column when the question names venues or malls', () => {
    expect(topic).toMatch(/names venues or malls, select the venue column too \(venue, event, pet, measure\)/);
  });
});
