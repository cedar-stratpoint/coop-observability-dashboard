// RET-05 (Stage 5, plan knowledge/tasks/2026-11-10-customer-contact-log-stage5.md): the manual contact log (customer_contacts).
// Every answer below is written by hand first. Owner rules: a team member logs a DM, SMS, call, hand-sent email or other contact
// against a website customer; it counts on the Customers tab and in Ask Coop, shown apart from the automated emails; only the
// person who logged a contact can delete it; a table that is not applied reads "unavailable", never 0; nothing ever sends.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  CHANNEL_LABEL,
  CONTACT_CHANNELS,
  CONTACT_NOTE_MAX,
  deleteContactWith,
  loadContactRows,
  logContactWith,
  readContactInput,
  type ContactLogDeps,
} from '../src/customer-contacts';
import {CONTACT_KIND_LABEL, contactTally, customerRows, type EnrichedCustomer} from '../src/crm-compute';
import {isMissingTable} from '../src/supabase-errors';

const ME = 'ana@zoomy.ph';
const ID = '0b6f6a52-2f6e-4f5e-9d33-6f1b8a3c9e01';

/** A fake store that records every write; `missing` makes it answer like a database without the table. */
function fakeDeps(o: {actor?: string | null; missing?: boolean; owner?: string} = {}) {
  const inserted: Record<string, unknown>[] = [];
  const deletes: Array<{id: string; by: string}> = [];
  const missing = {code: 'PGRST205', message: "Could not find the table 'public.customer_contacts' in the schema cache"};
  const deps: ContactLogDeps = {
    actor: async () => (o.actor === undefined ? ME : o.actor),
    insert: async (row) => {
      if (o.missing) return missing;
      inserted.push(row);
      return null;
    },
    deleteOwn: async (id, by) => {
      if (o.missing) return {error: missing, deleted: 0};
      deletes.push({id, by});
      return {error: null, deleted: by === (o.owner ?? ME) ? 1 : 0};
    },
  };
  return {deps, inserted, deletes};
}

describe('S5.0 logContact: validated in code, stamped with the signed-in email', () => {
  it('a valid contact is written lower-cased and trimmed, created_by from the session, never from the input', async () => {
    const {deps, inserted} = fakeDeps();
    const r = await logContactWith(deps, {email: '  Mia@Example.COM ', channel: 'dm', note: '  asked about the salmon treats  ', createdBy: 'someone@else.ph'});
    expect(r).toEqual({ok: true});
    expect(inserted).toEqual([{customer_email: 'mia@example.com', channel: 'dm', note: 'asked about the salmon treats', created_by: ME}]);
  });
  it('an empty note is stored as null', async () => {
    const {deps, inserted} = fakeDeps();
    expect(await logContactWith(deps, {email: 'mia@example.com', channel: 'call', note: '   '})).toEqual({ok: true});
    expect(inserted[0].note).toBeNull();
  });
  it('the channels are closed: instagram, facebook, viber first (most used, Stage 7B), then dm, sms, call, email, other', () => {
    expect([...CONTACT_CHANNELS]).toEqual(['instagram', 'facebook', 'viber', 'dm', 'sms', 'call', 'email', 'other']);
    expect(CONTACT_NOTE_MAX).toBe(500);
  });
  it.each([
    [{email: 'mia@example.com', channel: 'whatsapp', note: ''}, /channel/i],
    [{email: 'mia@example.com', channel: 'dm', note: 'x'.repeat(501)}, /500/],
    [{email: 'not-an-email', channel: 'dm', note: ''}, /email/i],
    [{email: '', channel: 'dm', note: ''}, /email/i],
    [{email: 'mia@example.com', channel: 'dm', note: 7}, /note/i],
    [null, /email/i],
  ])('refuses %j before any write', async (input, msg) => {
    const {deps, inserted} = fakeDeps();
    const r = await logContactWith(deps, input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
    expect(inserted).toEqual([]);
  });
  it('a 500-character note is accepted (the limit is inclusive)', () => {
    expect('error' in readContactInput({email: 'mia@example.com', channel: 'other', note: 'x'.repeat(500)})).toBe(false);
  });
  it('no session: refused, nothing written (there is no "coop" fallback author)', async () => {
    const {deps, inserted} = fakeDeps({actor: null});
    const r = await logContactWith(deps, {email: 'mia@example.com', channel: 'dm', note: ''});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/sign in/i);
    expect(inserted).toEqual([]);
  });
  it('the table is not applied yet: logging says it is not set up (no crash)', async () => {
    const {deps} = fakeDeps({missing: true});
    const r = await logContactWith(deps, {email: 'mia@example.com', channel: 'dm', note: ''});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not set up/i);
  });
});

describe('S5.0 deleteContact: only the person who logged it', () => {
  it('my own contact is deleted, filtered by id AND my email', async () => {
    const {deps, deletes} = fakeDeps();
    expect(await deleteContactWith(deps, ID)).toEqual({ok: true});
    expect(deletes).toEqual([{id: ID, by: ME}]);
  });
  it("someone else's contact is refused: the delete matched no row of mine", async () => {
    const {deps} = fakeDeps({owner: 'ben@zoomy.ph'});
    const r = await deleteContactWith(deps, ID);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/only delete a contact you logged/i);
  });
  it('a malformed id or no session is refused before any delete', async () => {
    const a = fakeDeps();
    expect((await deleteContactWith(a.deps, "1' or '1'='1")).ok).toBe(false);
    const b = fakeDeps({actor: null});
    expect((await deleteContactWith(b.deps, ID)).ok).toBe(false);
    expect([...a.deletes, ...b.deletes]).toEqual([]);
  });
  it('the table is not applied yet: says so', async () => {
    const r = await deleteContactWith(fakeDeps({missing: true}).deps, ID);
    expect(!r.ok && r.error).toMatch(/not set up/i);
  });
});

describe('S5.0 the read: a missing table is null ("unavailable"), never an empty list', () => {
  const page = (rows: Record<string, unknown>[] | null, error: {code?: string; message: string} | null = null) => async () => ({data: rows, error});
  it('rows are projected (email lower-cased)', async () => {
    const rows = await loadContactRows(page([{id: ID, customer_email: 'Mia@Example.com', channel: 'sms', note: 'hi', contacted_at: '2026-11-10T02:00:00Z', created_by: ME}]));
    expect(rows).toEqual([{id: ID, email: 'mia@example.com', channel: 'sms', note: 'hi', contactedAt: '2026-11-10T02:00:00Z', createdBy: ME}]);
  });
  it.each([
    [{code: 'PGRST205', message: "Could not find the table 'public.customer_contacts' in the schema cache"}],
    [{code: '42P01', message: 'relation "public.customer_contacts" does not exist'}],
  ])('%j gives null', async (error) => {
    expect(await loadContactRows(page(null, error))).toBeNull();
  });
  it('any other read failure is also null (unknown), never []', async () => {
    expect(await loadContactRows(page(null, {code: '57014', message: 'canceling statement due to statement timeout'}))).toBeNull();
  });
  it('isMissingTable knows both codes and the PostgREST message', () => {
    expect(isMissingTable({code: 'PGRST205', message: ''})).toBe(true);
    expect(isMissingTable({code: '42P01', message: ''})).toBe(true);
    expect(isMissingTable({code: 'XX000', message: "Could not find the table 'public.x' in the schema cache"})).toBe(true);
    expect(isMissingTable({code: '23505', message: 'duplicate key'})).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

describe('S5.0 contactTally with manual contacts: one code path for the page and Ask Coop', () => {
  const src = {
    checkouts: [{email: 'mia@example.com', remindersSent: 2, winbackSentAt: null}],
    orders: [{email: 'mia@example.com', reviewRequestSentAt: 'x', test: false}],
    birthdayVouchers: [],
  };
  it('manual counts 1 per logged contact, apart from the automated emails; total = automated + manual', () => {
    const t = contactTally({...src, manualContacts: [{email: 'MIA@example.com'}, {email: 'mia@example.com '}, {email: 'leo@example.com'}, {email: null}]});
    expect(t.get('mia@example.com')).toEqual({reminders: 2, winback: 0, reviewRequests: 1, birthdayVouchers: 0, membership: 0, automated: 3, manual: 2, total: 5, lastAt: null, lastKind: null});
    expect(t.get('leo@example.com')).toEqual({reminders: 0, winback: 0, reviewRequests: 0, birthdayVouchers: 0, membership: 0, automated: 0, manual: 1, total: 1, lastAt: null, lastKind: null});
  });
  it('without manual contacts the tally is the Stage 3 one (manual 0)', () => {
    expect(contactTally(src).get('mia@example.com')).toMatchObject({automated: 3, manual: 0, total: 3});
  });

  const NOW = new Date('2026-11-10T04:00:00Z');
  const c = (email: string): EnrichedCustomer => ({
    shopifyCustomerId: email, email, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null,
    petName: null, petBirthday: null, emailMarketingState: null, createdAt: null, updatedAt: null,
    orderCount: 1, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null,
  });
  const tally = contactTally({...src, manualContacts: [{email: 'mia@example.com'}]});
  it('the page row shows emails sent and manual contacts separately, and times contacted as their sum', () => {
    const [mia, noa] = customerRows([c('mia@example.com'), c('noa@example.com')], tally, NOW, {automated: true, manual: true});
    expect([mia.emailsSent, mia.manualContacts, mia.timesContacted]).toEqual([3, 1, 4]);
    expect([noa.emailsSent, noa.manualContacts, noa.timesContacted]).toEqual([0, 0, 0]);
  });
  it('the log not applied: manual and times contacted are null ("unavailable"), never 0; emails sent still shows', () => {
    const [mia] = customerRows([c('mia@example.com')], tally, NOW, {automated: true, manual: false});
    expect([mia.emailsSent, mia.manualContacts, mia.timesContacted]).toEqual([3, null, null]);
  });
  it('a CRM source unread: emails sent and times contacted are null; the manual count still shows', () => {
    const [mia] = customerRows([c('mia@example.com')], tally, NOW, {automated: false, manual: true});
    expect([mia.emailsSent, mia.manualContacts, mia.timesContacted]).toEqual([null, 1, null]);
  });
});

describe('S5.0 negative: no send path, and the table stays service-role only', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  const files = ['src/customer-contacts.ts', 'src/customer-contacts-actions.ts', 'src/customer-contacts-data.ts', 'app/api/chat/contacts-log-seam.ts'];
  it('no module of the log can send anything: no fetch, mail client, CRM client or POST', () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bfetch\(|resend|sendEmail|sendMail|nodemailer|crm-data|createCrmClient|postShopify|\/admin/i);
    }
  });
  it('the DDL turns RLS on and adds no policy and no grant, and checks the channel and the note length', () => {
    const sql = read('supabase/customer_contacts.sql').replace(/--.*$/gm, '');
    expect(sql).toMatch(/create table if not exists public\.customer_contacts/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/create policy|grant /i);
    expect(sql).toMatch(/channel in \('dm', 'sms', 'call', 'email', 'other', 'instagram', 'facebook', 'viber'\)/);
    expect(sql).toMatch(/char_length\(note\) <= 500/);
    expect(sql).toMatch(/customer_email = lower\(customer_email\)/);
  });
});

describe('writeError: the PostgREST 404-with-empty-body quirk on a missing table', () => {
  it('a 404 with an empty error reads as a missing table, so the action says "not set up"', async () => {
    const {writeError, isMissingTable} = await import('../src/supabase-errors');
    expect(isMissingTable(writeError({error: {}, status: 404}))).toBe(true);
    expect(isMissingTable(writeError({error: {code: '23514', message: 'check violation'}, status: 400}))).toBe(false);
    expect(writeError({error: null, status: 201})).toBeNull();
  });
});

// RET-07 Stage 7B (plan knowledge/tasks/2026-11-11-customer-last-contacted-stage7.md, rule R6): Instagram, Facebook and Viber
// become their own channels; 'dm' stays (relabelled "DM (other app)") so rows logged before 7B stay valid.
describe('S7B Instagram / Facebook / Viber channels', () => {
  it.each(['instagram', 'facebook', 'viber'])('accepts %s and writes it as the channel', async (channel) => {
    const {deps, inserted} = fakeDeps();
    expect(await logContactWith(deps, {email: 'mia@example.com', channel, note: ''})).toEqual({ok: true});
    expect(inserted[0].channel).toBe(channel);
  });
  it.each(['tiktok', 'Instagram', 'ig', ''])('still refuses an unknown channel (%j) before any write', async (channel) => {
    const {deps, inserted} = fakeDeps();
    const r = await logContactWith(deps, {email: 'mia@example.com', channel, note: ''});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/channel/i);
    expect(inserted).toEqual([]);
  });
  it('labels: Instagram, Facebook, Viber, and dm reads "DM (other app)"', () => {
    expect(CHANNEL_LABEL).toEqual({instagram: 'Instagram', facebook: 'Facebook', viber: 'Viber', dm: 'DM (other app)', sms: 'SMS', call: 'Call', email: 'Email (by hand)', other: 'Other'});
  });
  it('an old dm row still reads and labels fine', async () => {
    const page = async () => ({data: [{id: ID, customer_email: 'mia@example.com', channel: 'dm', note: null, contacted_at: '2026-11-01T02:00:00Z', created_by: ME}], error: null});
    const rows = await loadContactRows(page);
    expect(rows?.[0].channel).toBe('dm');
    expect(CHANNEL_LABEL[rows![0].channel]).toBe('DM (other app)');
  });
  it('the 7A tally keeps each new channel as its own last-contact kind (not "other"), with its own label', () => {
    const base = {checkouts: [], orders: [], birthdayVouchers: []};
    for (const [channel, label] of [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['viber', 'Viber'], ['dm', 'DM (other app)']] as const) {
      const t = contactTally({...base, manualContacts: [{email: 'a@x.com', channel, contactedAt: '2026-11-05T10:00:00Z'}]});
      expect(t.get('a@x.com')).toMatchObject({manual: 1, lastAt: '2026-11-05T10:00:00Z', lastKind: channel});
      expect(CONTACT_KIND_LABEL[channel]).toBe(label);
    }
    const t = contactTally({...base, manualContacts: [{email: 'a@x.com', channel: 'tiktok', contactedAt: '2026-11-05T10:00:00Z'}]});
    expect(t.get('a@x.com')?.lastKind).toBe('other');
  });
  it('the old check constraint (Stage 7B SQL not applied) gets a clear "run the SQL" message, nothing else changes', async () => {
    const inserted: unknown[] = [];
    const deps: ContactLogDeps = {
      actor: async () => ME,
      insert: async (row) => {
        inserted.push(row);
        return {code: '23514', message: 'new row for relation "customer_contacts" violates check constraint "customer_contacts_channel_check"'};
      },
      deleteOwn: async () => ({error: null, deleted: 0}),
    };
    const r = await logContactWith(deps, {email: 'mia@example.com', channel: 'instagram', note: ''});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/isn't enabled in the database yet/);
    expect(!r.ok && r.error).toContain('supabase/customer_contacts_channels_7b.sql');
  });
  it('a different check violation (e.g. the note length) keeps the generic failure message', async () => {
    const deps: ContactLogDeps = {
      actor: async () => ME,
      insert: async () => ({code: '23514', message: 'new row for relation "customer_contacts" violates check constraint "customer_contacts_note_check"'}),
      deleteOwn: async () => ({error: null, deleted: 0}),
    };
    const r = await logContactWith(deps, {email: 'mia@example.com', channel: 'viber', note: 'x'});
    expect(!r.ok && r.error).toMatch(/Saving the contact failed/);
  });
  it('the DDL widens the existing constraint idempotently, and the standalone 7B file carries the same ALTER', () => {
    const widen = /alter table public\.customer_contacts drop constraint if exists customer_contacts_channel_check;\s*alter table public\.customer_contacts add constraint customer_contacts_channel_check\s+check \(channel in \('dm', 'sms', 'call', 'email', 'other', 'instagram', 'facebook', 'viber'\)\);/;
    expect(readFileSync('supabase/customer_contacts.sql', 'utf8')).toMatch(widen);
    const sql7b = readFileSync('supabase/customer_contacts_channels_7b.sql', 'utf8');
    expect(sql7b).toMatch(widen);
    expect(sql7b).toMatch(/BEFORE deploying/);
  });
});
