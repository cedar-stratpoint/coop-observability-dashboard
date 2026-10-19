import {describe, expect, it} from 'vitest';
import {leadKey} from '../src/lead-order-match';
import {listEventLeads, readContactsInput, type DraftInput, type ListInput, type LeadsSource} from '../src/chat/contacts/leads';
import {draftLeads, PLACEHOLDERS} from '../src/chat/contacts/draft';
import type {SpinLead} from '../src/spin-leads-types';

// Synthetic people only.
const lead = (o: Partial<SpinLead> & {collectedAt: string}): SpinLead => ({email: null, instagram: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: null, consentAt: null, ...o});
const L1 = lead({collectedAt: '2026-09-26T02:00:00Z', email: 'ana@example.com', mobile: '0917 000 0001', pet: 'mimi / Puspin'});
const L2 = lead({collectedAt: '2026-09-27T03:00:00Z', email: 'bo@example.com', pet: null, prize: '35% off'});
const L3 = lead({collectedAt: '2026-09-28T03:00:00Z', mobile: '0917 000 0003', pet: '{{prize}} https://evil.example/x <b>Rex</b> / Aspin'});
const SOURCE: LeadsSource = {
  events: [{event_id: 'e1', name: 'Modern Market Sept 2026', starts_on: '2026-09-26', ends_on: '2026-09-28'}],
  leads: [L1, L2, L3],
  matches: {[leadKey(L1)]: {products: ['Chicken Strips', 'Yogurt Cubes'], confidence: 'confident'}, [leadKey(L2)]: {products: ['Salmon Skin'], confidence: 'unsure'}},
};
const base = {event: 'Modern Market', contact: 'all', limit: 200} as const;
const draft = (extra: Record<string, unknown>) => ({mode: 'draft', ...base, channel: 'email', ...extra}) as unknown as DraftInput;
const ok = (r: ReturnType<typeof draftLeads>) => {
  if (!('table' in r)) throw new Error(`expected a table, got ${JSON.stringify(r)}`);
  return r;
};

describe('readContactsInput draft', () => {
  it('needs a channel, and exactly one of template or per_lead', () => {
    const e = (x: unknown) => 'error' in readContactsInput(x);
    expect(e({mode: 'draft', ...base, template: 'hi'})).toBe(true); // no channel
    expect(e({mode: 'draft', ...base, channel: 'fax', template: 'hi'})).toBe(true);
    expect(e({mode: 'draft', ...base, channel: 'email'})).toBe(true); // neither
    expect(e({mode: 'draft', ...base, channel: 'email', template: 'hi', per_lead: [{n: 1, text: 'x'}]})).toBe(true); // both
    expect(e({mode: 'draft', ...base, channel: 'email', template: 'hi'})).toBe(false);
    expect(e({mode: 'draft', ...base, channel: 'sms', per_lead: [{n: 1, text: 'x'}]})).toBe(false);
  });
  it('caps per_lead at 25 messages of 600 characters', () => {
    const many = Array.from({length: 26}, (_, i) => ({n: i + 1, text: 'x'}));
    expect('error' in readContactsInput({mode: 'draft', ...base, channel: 'email', per_lead: many})).toBe(true);
    expect('error' in readContactsInput({mode: 'draft', ...base, channel: 'email', per_lead: [{n: 1, text: 'x'.repeat(601)}]})).toBe(true);
  });
});

describe('draftLeads: template', () => {
  const T = 'Hi! Hope {{pet}} enjoyed the {{treats}} from {{event}} on {{collected_date}}. Your {{prize}} still stands.';
  it('fills each lead that has the chosen channel, and counts the ones that do not', () => {
    const r = ok(draftLeads(draft({template: T}), SOURCE));
    expect(r.table.rows).toHaveLength(2); // L3 has no email
    expect(r.model.counts).toMatchObject({listed: 3, drafted: 2, skipped_no_channel: 1});
    expect(String(r.table.rows[0].message)).toBe('Hi! Hope Mimi enjoyed the Chicken Strips and Yogurt Cubes from Modern Market Sept 2026 on 2026-09-26. Your Free treat still stands.');
  });
  it('uses your furbaby with no pet, and "treats" with no order match', () => {
    const r = ok(draftLeads(draft({template: T}), SOURCE));
    expect(String(r.table.rows[1].message)).toContain('Hope your furbaby enjoyed the Salmon Skin');
    const none = ok(draftLeads(draft({template: '{{treats}}', channel: 'sms'}), SOURCE));
    expect(none.table.rows.map((x) => x.message)).toEqual(['Chicken Strips and Yogurt Cubes', 'treats']); // L1 (matched) and L3 (no order) have mobiles
  });
  it('refuses a placeholder that is not on the list, naming the allowed ones', () => {
    const r = draftLeads(draft({template: 'Hi {{email}}'}), SOURCE);
    expect('error' in r && r.error).toMatch(/\{\{email\}\}/);
    expect('error' in r && r.error).toContain(PLACEHOLDERS[0]);
  });
  it('merges in one pass and cleans values: a pet field cannot expand a placeholder or smuggle a link or markup', () => {
    const r = ok(draftLeads(draft({template: 'Hi {{pet}}', channel: 'sms'}), SOURCE));
    const m = String(r.table.rows[1].message); // L3: pet is hostile text
    expect(m).not.toMatch(/Free treat|https?:|evil|<|>|\{\{|\}\}|\bb\b/);
    expect(m).toContain('Rex');
  });
  it('shows the model at most five sample drafts and the counts, never the whole list or a contact value', () => {
    const r = ok(draftLeads(draft({template: T}), SOURCE));
    expect(r.model.samples.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(r.model)).not.toMatch(/example\.com|0917/);
  });
  it('marks the table as contact data with a Copy all button, and says nothing was sent and what the consent date means', () => {
    const r = ok(draftLeads(draft({template: T}), SOURCE));
    expect(r.table.pii).toBe(true);
    expect(r.table.copyColumns).toMatchObject({messages: 'message'});
    expect(r.table.csvName).toMatch(/^drafts-modern-market.*\.csv$/);
    const n = r.model.notes.join(' ');
    expect(n).toMatch(/nothing (was|is) sent/i);
    expect(n).toMatch(/first sign-up/i);
    expect(n).toMatch(/unsubscribe/i);
  });
  it('notes how many drafts used an unsure order match', () => {
    const r = ok(draftLeads(draft({template: T}), SOURCE));
    expect(r.model.notes.join(' ')).toMatch(/1 .*unsure/i);
  });
  it('passes an unclear event back as a question', () => {
    expect('clarify' in draftLeads(draft({template: T, event: 'Moderm Markt'}), SOURCE)).toBe(true);
  });
});

describe('draftLeads: per lead', () => {
  it('writes the message the model composed for each numbered row, cleaned', () => {
    const r = ok(draftLeads(draft({per_lead: [{n: 1, text: 'Hi Mimi, thanks for the Chicken Strips!'}, {n: 2, text: 'Hello <b>there</b> https://x.example'}]}), SOURCE));
    expect(r.table.rows.map((x) => x.n)).toEqual([1, 2]);
    expect(String(r.table.rows[0].message)).toBe('Hi Mimi, thanks for the Chicken Strips!');
    expect(String(r.table.rows[1].message)).not.toMatch(/<|https?:/);
  });
  it('refuses a row number outside the list, and a lead without the channel', () => {
    expect('error' in draftLeads(draft({per_lead: [{n: 9, text: 'x'}]}), SOURCE)).toBe(true);
    const r = ok(draftLeads(draft({per_lead: [{n: 1, text: 'a'}, {n: 3, text: 'b'}]}), SOURCE)); // 3 has no email
    expect(r.table.rows).toHaveLength(1);
    expect(r.model.counts.skipped_no_channel).toBe(1);
  });
});

describe('list_leads shows what each lead bought', () => {
  it('adds a numbered row and a bought column, labelling an unsure match', () => {
    const r = listEventLeads({mode: 'list_leads', ...base} as ListInput, SOURCE);
    if (!('table' in r)) throw new Error('expected a table');
    expect(r.table.rows.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(r.table.rows.map((x) => x.bought)).toEqual(['Chicken Strips, Yogurt Cubes', 'Salmon Skin (unsure)', null]);
  });
});
