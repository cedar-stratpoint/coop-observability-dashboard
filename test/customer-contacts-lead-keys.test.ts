// RET-17 Task 1 (plan knowledge/tasks/2026-11-25-ret17-implementation-plan.md): the contact log takes an Instagram handle or a
// mobile as well as an email, and a "they replied" flag. Supabase/customer_contacts_lead_keys.sql adds the columns; until it is
// applied, reads fall back to the old columns and logging by Instagram / mobile says "not set up" (email logging keeps working).
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {hasLoggableKey, loadContactLog, loadContactRows, loggableKeys, logContactWith, readContactInput, withColumnFallback, type ContactLogDeps, type NewContactRow} from '../src/customer-contacts';

const ME = 'ana@zoomy.ph';
const ID = '0b6f6a52-2f6e-4f5e-9d33-6f1b8a3c9e01';
const MISSING_COLUMN = {code: '42703', message: 'column customer_contacts.contact_instagram does not exist'};

function fakeDeps(insertError: {code?: string; message: string} | null = null) {
  const inserted: NewContactRow[] = [];
  const deps: ContactLogDeps = {
    actor: async () => ME,
    insert: async (row) => {
      inserted.push(row);
      return insertError;
    },
    deleteOwn: async () => ({error: null, deleted: 0}),
  };
  return {deps, inserted};
}

describe('readContactInput: email, Instagram or mobile', () => {
  it('an Instagram handle typed "@Karla.Sy" is stored as karla.sy', () => {
    expect(readContactInput({instagram: '@Karla.Sy', channel: 'instagram', note: ''})).toEqual({
      email: null, instagram: 'karla.sy', mobile: null, channel: 'instagram', note: null, replied: false,
    });
  });
  it('a mobile is stored as its last 10 digits; replied true is kept', () => {
    expect(readContactInput({mobile: '+63 917 148 8749', channel: 'sms', note: '', replied: true})).toEqual({
      email: null, instagram: null, mobile: '9171488749', channel: 'sms', note: null, replied: true,
    });
  });
  it('an email still works as before (replied defaults to false)', () => {
    expect(readContactInput({email: ' Mia@Example.com ', channel: 'dm', note: 'hi'})).toEqual({
      email: 'mia@example.com', instagram: null, mobile: null, channel: 'dm', note: 'hi', replied: false,
    });
  });
  it('no email, Instagram or mobile is refused', () => {
    const r = readContactInput({channel: 'sms', note: ''});
    expect('error' in r && r.error).toMatch(/email, Instagram or mobile/);
  });
  it.each([
    [{instagram: 'not a handle!', channel: 'instagram', note: ''}, /Instagram/],
    [{mobile: '12345', channel: 'sms', note: ''}, /mobile/],
    [{email: 'not-an-email', instagram: 'karla.sy', channel: 'dm', note: ''}, /email/i],
    [{instagram: 'karla.sy', channel: 'dm', note: '', replied: 'yes'}, /replied/i],
  ])('refuses %j', (input, msg) => {
    const r = readContactInput(input);
    expect('error' in r && r.error).toMatch(msg);
  });
});

describe('logContactWith: new columns are written only when used', () => {
  it('an Instagram-only contact writes contact_instagram and no customer_email', async () => {
    const {deps, inserted} = fakeDeps();
    expect(await logContactWith(deps, {instagram: '@Karla.Sy', channel: 'instagram', note: ''})).toEqual({ok: true});
    expect(inserted).toEqual([{customer_email: null, contact_instagram: 'karla.sy', channel: 'instagram', note: null, created_by: ME}]);
  });
  it('a mobile contact that replied writes contact_mobile and replied', async () => {
    const {deps, inserted} = fakeDeps();
    expect(await logContactWith(deps, {mobile: '09171488749', channel: 'sms', note: '', replied: true})).toEqual({ok: true});
    expect(inserted).toEqual([{customer_email: null, contact_mobile: '9171488749', replied: true, channel: 'sms', note: null, created_by: ME}]);
  });
  it('an email-only contact writes exactly the old row (works on a DB without the new columns)', async () => {
    const {deps, inserted} = fakeDeps();
    expect(await logContactWith(deps, {email: 'mia@example.com', channel: 'dm', note: ''})).toEqual({ok: true});
    expect(inserted).toEqual([{customer_email: 'mia@example.com', channel: 'dm', note: null, created_by: ME}]);
  });
  it.each([
    MISSING_COLUMN,
    {code: 'PGRST204', message: "Could not find the 'contact_instagram' column of 'customer_contacts' in the schema cache"},
  ])('the new columns are not applied (%j): an Instagram-only contact says "not set up"', async (error) => {
    const {deps} = fakeDeps(error);
    const r = await logContactWith(deps, {instagram: 'karla.sy', channel: 'instagram', note: ''});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not set up/);
    expect(!r.ok && r.error).toContain('supabase/customer_contacts_lead_keys.sql');
  });
  it('the old NOT NULL on customer_email (23502) also says "not set up"', async () => {
    const {deps} = fakeDeps({code: '23502', message: 'null value in column "customer_email" of relation "customer_contacts" violates not-null constraint'});
    const r = await logContactWith(deps, {mobile: '09171488749', channel: 'sms', note: ''});
    expect(!r.ok && r.error).toMatch(/not set up/);
  });
});

describe('loadContactRows: the new columns, and their absence', () => {
  const page = (rows: Record<string, unknown>[]) => async () => ({data: rows, error: null});
  it('maps contact_instagram, contact_mobile and replied', async () => {
    const rows = await loadContactRows(page([{id: ID, customer_email: null, contact_instagram: 'karla.sy', contact_mobile: '9171488749', replied: true, channel: 'instagram', note: null, contacted_at: '2026-11-20T02:00:00Z', created_by: ME}]));
    expect(rows).toEqual([{id: ID, email: null, instagram: 'karla.sy', mobile: '9171488749', channel: 'instagram', note: null, replied: true, contactedAt: '2026-11-20T02:00:00Z', createdBy: ME}]);
  });
  it('an old row without the columns reads null / false', async () => {
    const rows = await loadContactRows(page([{id: ID, customer_email: 'Mia@Example.com', channel: 'sms', note: 'hi', contacted_at: '2026-11-10T02:00:00Z', created_by: ME}]));
    expect(rows).toEqual([{id: ID, email: 'mia@example.com', instagram: null, mobile: null, channel: 'sms', note: 'hi', replied: false, contactedAt: '2026-11-10T02:00:00Z', createdBy: ME}]);
  });
  it('withColumnFallback: a 42703 on the new select switches to the old select (for every later page too)', async () => {
    const calls: string[] = [];
    const make = (name: string, error: typeof MISSING_COLUMN | null) => async (from: number, to: number) => {
      calls.push(`${name}:${from}`);
      return {data: error ? null : [{id: ID, customer_email: 'mia@example.com', channel: 'sms', note: null, contacted_at: '2026-11-10T02:00:00Z', created_by: ME}].slice(0, to - from + 1), error};
    };
    const rows = await loadContactRows(withColumnFallback(make('new', MISSING_COLUMN), make('old', null)));
    expect(rows).toEqual([{id: ID, email: 'mia@example.com', instagram: null, mobile: null, channel: 'sms', note: null, replied: false, contactedAt: '2026-11-10T02:00:00Z', createdBy: ME}]);
    expect(calls[0]).toBe('new:0');
    expect(calls[1]).toBe('old:0');
  });
  it('withColumnFallback: any other error is passed through (the read is then null, unknown)', async () => {
    const other = async () => ({data: null, error: {code: '57014', message: 'timeout'}});
    const old = async () => ({data: [], error: null});
    expect(await loadContactRows(withColumnFallback(other, old))).toBeNull();
  });
});

describe('loadContactLog: says when the read fell back to the legacy columns', () => {
  const row = {id: ID, customer_email: 'mia@example.com', channel: 'sms', note: null, contacted_at: '2026-11-10T02:00:00Z', created_by: ME};
  it('new columns present: legacy false', async () => {
    const log = await loadContactLog(async () => ({data: [{...row, contact_instagram: null, contact_mobile: null, replied: false}], error: null}), async () => ({data: [], error: null}));
    expect(log?.legacy).toBe(false);
    expect(log?.rows).toHaveLength(1);
  });
  it('a 42703 on the new select: legacy true, rows from the old select', async () => {
    const log = await loadContactLog(async () => ({data: null, error: MISSING_COLUMN}), async () => ({data: [row], error: null}));
    expect(log).toEqual({legacy: true, rows: [{id: ID, email: 'mia@example.com', instagram: null, mobile: null, channel: 'sms', note: null, replied: false, contactedAt: '2026-11-10T02:00:00Z', createdBy: ME}]});
  });
  it('an unreadable log is null', async () => {
    expect(await loadContactLog(async () => ({data: null, error: {code: '57014', message: 'timeout'}}), async () => ({data: [], error: null}))).toBeNull();
  });
});

describe('supabase/customer_contacts_lead_keys.sql', () => {
  const sql = readFileSync('supabase/customer_contacts_lead_keys.sql', 'utf8').replace(/--.*$/gm, '');
  it('adds the columns idempotently with their checks, and requires at least one key', () => {
    expect(sql).toMatch(/alter column customer_email drop not null/i);
    expect(sql).toMatch(/add column if not exists contact_instagram text/i);
    expect(sql).toMatch(/add column if not exists contact_mobile text/i);
    expect(sql).toMatch(/add column if not exists replied boolean not null default false/i);
    expect(sql).toMatch(/customer_email is not null or contact_instagram is not null or contact_mobile is not null/);
    expect(sql).toMatch(/create index if not exists \w+ on public\.customer_contacts \(contact_instagram/i);
    expect(sql).toMatch(/create index if not exists \w+ on public\.customer_contacts \(contact_mobile/i);
    expect(sql).not.toMatch(/create policy|grant /i);
  });
});

// Priority update (owner 2026-11-25): "When" = an editable last-contacted day. A PH day, never in the future; today (or none)
// leaves contacted_at to the database's now(), a past day is stored as noon PH that day so it reads back as that day.
describe('contactedAt: the "When" of a logged contact', () => {
  const NOW = new Date('2026-11-25T03:00:00Z'); // 11:00 PH, Nov 25
  it('a past PH day is stored as noon PH that day', () => {
    const r = readContactInput({email: 'mia@example.com', channel: 'dm', note: '', contactedAt: '2026-11-20'}, NOW);
    expect(r).toMatchObject({contactedAt: '2026-11-20T12:00:00+08:00'});
  });
  it('today, or no day, leaves the time to the database (now)', () => {
    expect('contactedAt' in (readContactInput({email: 'mia@example.com', channel: 'dm', note: '', contactedAt: '2026-11-25'}, NOW) as object)).toBe(false);
    expect('contactedAt' in (readContactInput({email: 'mia@example.com', channel: 'dm', note: ''}, NOW) as object)).toBe(false);
  });
  it('today is the PH day, not the UTC one (Nov 25 16:30 UTC is already Nov 26 in Manila)', () => {
    const late = new Date('2026-11-25T16:30:00Z');
    expect('error' in (readContactInput({email: 'mia@example.com', channel: 'dm', note: '', contactedAt: '2026-11-26'}, late) as object)).toBe(false);
  });
  it.each([['2026-11-26', /future/], ['2026-13-01', /date/i], ['2026-02-30', /date/i], ['11/20/2026', /date/i], [20261120, /date/i]])('refuses %j', (day, msg) => {
    const r = readContactInput({email: 'mia@example.com', channel: 'dm', note: '', contactedAt: day}, NOW);
    expect('error' in r && r.error).toMatch(msg);
  });
  it('logContactWith writes contacted_at only for a past day', async () => {
    const {deps, inserted} = fakeDeps();
    expect(await logContactWith(deps, {instagram: 'karla.sy', channel: 'instagram', note: '', contactedAt: '2026-11-20'}, NOW)).toEqual({ok: true});
    expect(await logContactWith(deps, {email: 'mia@example.com', channel: 'dm', note: ''}, NOW)).toEqual({ok: true});
    expect(inserted[0]).toMatchObject({contact_instagram: 'karla.sy', contacted_at: '2026-11-20T12:00:00+08:00'});
    expect(inserted[1]).not.toHaveProperty('contacted_at');
  });
});

// Review fix: the Log dialog sends only keys the server accepts, normalised; a bad booth mobile no longer blocks a good email.
describe('loggableKeys', () => {
  it('normalises and drops invalid keys', () => {
    expect(loggableKeys({email: ' Mia@Example.com ', instagram: '@Karla.Sy', mobile: '+63 917 148 8749'})).toEqual({email: 'mia@example.com', instagram: 'karla.sy', mobile: '9171488749'});
    expect(loggableKeys({email: 'mia@example.com', instagram: '@karla sy', mobile: 'N/A'})).toEqual({email: 'mia@example.com', instagram: null, mobile: null});
    expect(loggableKeys({email: 'not-an-email', instagram: null, mobile: '917148874'})).toEqual({email: null, instagram: null, mobile: null});
  });
  it('legacy (SQL not applied) keeps the email only', () => {
    expect(loggableKeys({email: 'mia@example.com', instagram: 'karla.sy', mobile: '09171488749'}, true)).toEqual({email: 'mia@example.com', instagram: null, mobile: null});
  });
  it('what it returns always passes readContactInput', () => {
    const k = loggableKeys({email: 'mia@example.com', instagram: '@karla sy', mobile: '12'});
    expect('error' in readContactInput({...k, channel: 'dm', note: ''})).toBe(false);
  });
  it('hasLoggableKey is false when nothing valid is left', () => {
    expect(hasLoggableKey({email: 'N/A', instagram: '@ bad handle', mobile: '123'})).toBe(false);
    expect(hasLoggableKey({email: null, instagram: null, mobile: '0917 148 8749'})).toBe(true);
  });
});
