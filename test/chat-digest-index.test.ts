import {describe, expect, it} from 'vitest';
import {readDigestIndex, readDigestRowAt, DIGEST_INDEX_LIMIT, type DigestReadClient, type DigestRowReadClient} from '../src/chat/read/digest';
import {DIGEST_COLUMNS, DIGEST_INDEX_COLUMNS} from '../src/chat/read/relations';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

type Call = {relation: string; columns: string; eq: [string, string][]; order?: [string, unknown]; limit?: number};
function fake(data: unknown[] | null, error: {message: string} | null = null) {
  const calls: Call[] = [];
  const client = {
    from: (relation: string) => ({
      select: (columns: string) => {
        const call: Call = {relation, columns, eq: []};
        calls.push(call);
        const b = {
          order: (c: string, o?: {ascending?: boolean}) => ((call.order = [c, o?.ascending]), b),
          limit: (n: number) => ((call.limit = n), b),
          eq: (c: string, v: string) => (call.eq.push([c, v]), b),
          then: (ok: (v: {data: unknown[] | null; error: {message: string} | null}) => unknown) => Promise.resolve({data, error}).then(ok),
        };
        return b;
      },
    }),
  };
  return {client: client as unknown as DigestReadClient & DigestRowReadClient, calls};
}

describe('the window index read (F.5)', () => {
  it('reads only window_from, window_to and created_at, newest first, never the documents or the bundle', async () => {
    const {client, calls} = fake([{window_from: 'a', window_to: 'b', created_at: 'c'}, {window_to: 'x'}]);
    expect(await readDigestIndex(client, 'guarded_service')).toEqual([{from: 'a', to: 'b', createdAt: 'c'}]);
    expect(calls[0]).toMatchObject({relation: 'digest_archive', columns: DIGEST_INDEX_COLUMNS, order: ['window_to', false], limit: DIGEST_INDEX_LIMIT});
    expect(DIGEST_INDEX_COLUMNS).toBe('window_from,window_to,created_at');
    expect(DIGEST_INDEX_COLUMNS).not.toMatch(/digest\b|bundle/);
  });
  it('throws on a read error (the caller degrades)', async () => {
    await expect(readDigestIndex(fake(null, {message: 'boom'}).client, 'ro_role')).rejects.toThrow(/digest index read failed: boom/);
  });
});

describe('one older digest by its exact window and run', () => {
  it('filters on all three keys and returns the masked row, or null', async () => {
    const {client, calls} = fake([{...SEPTEMBER_ROWS[0], window_from: 'a', window_to: 'b', created_at: 'c'}]);
    const row = await readDigestRowAt(client, 'ro_role', {from: 'a', to: 'b', createdAt: 'c'});
    expect(row?.digest.headline).toBe('FICTIONAL');
    expect(calls[0]).toMatchObject({relation: 'coop_chat_digest', columns: DIGEST_COLUMNS, eq: [['window_from', 'a'], ['window_to', 'b'], ['created_at', 'c']], limit: 1});
    expect(await readDigestRowAt(fake([]).client, 'ro_role', {from: 'a', to: 'b', createdAt: 'c'})).toBeNull();
  });
});
