// Train 4 drawer wiring, without a browser or an export: the drawer's own `loadMessages` is cut out of the source, transpiled and run
// (the file cannot be imported in node: it uses the @/ alias and React). The untrusted flag survives a reload only when it is exactly
// true, and the drawer feeds it to the markdown renderer's known-hosts-only mode.
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';
import {sanitizeBlocks} from '../components/analyst/chat-blocks-format';

const src = readFileSync('components/analyst/coop-chat.tsx', 'utf8');
const start = src.indexOf('function loadMessages(');
const end = src.indexOf('\n}\n', start) + 3;
const js = ts.transpileModule(src.slice(start, end), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const loadMessages = new Function('sanitizeBlocks', `${js}\nreturn loadMessages;`)(sanitizeBlocks) as (raw: string) => Record<string, unknown>[];
const load = (m: Record<string, unknown>) => loadMessages(JSON.stringify([{role: 'assistant', content: 'hi', ...m}]))[0];

describe('loadMessages keeps untrusted: true and drops anything else', () => {
  it('found the real function', () => expect(start).toBeGreaterThan(0));
  it('keeps exactly true', () => expect(load({untrusted: true})).toMatchObject({untrusted: true}));
  it.each([['false', false], ['string', 'true'], ['one', 1], ['null', null], ['object', {}]])('drops %s', (_n, v) => expect('untrusted' in load({untrusted: v})).toBe(false));
  it('an absent flag stays absent', () => expect('untrusted' in load({})).toBe(false));
});

describe('the drawer passes the flag to the renderer', () => {
  it('knownHostsOnly is driven by the flag of this or any earlier message', () => expect(src).toMatch(/knownHostsOnly=\{untrustedThrough\(messages, i\) \|\|/));
  it('the flag is not sent back to the server with the history', () => expect(src).toMatch(/blocks: _blocks, untrusted: _untrusted, \.\.\.rest/));
});

describe('links stay plain through history (final fix wave)', () => {
  const s = src.indexOf('function untrustedThrough(');
  const e = src.indexOf('\n}\n', s) + 3;
  const fn = s > 0 ? (new Function(`${ts.transpileModule(src.slice(s, e), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText}\nreturn untrustedThrough;`)() as (m: {untrusted?: true}[], i: number) => boolean) : null;
  it('found the helper', () => expect(s).toBeGreaterThan(0));
  it('a later clean answer is plain when an earlier one was flagged', () => expect(fn?.([{}, {untrusted: true}, {}, {}], 3)).toBe(true));
  it('messages before the flagged one are not affected', () => expect(fn?.([{}, {untrusted: true}], 0)).toBe(false));
  it('no flag anywhere is false', () => expect(fn?.([{}, {}], 1)).toBe(false));
  it('the drawer uses it', () => expect(src).toMatch(/knownHostsOnly=\{untrustedThrough\(messages, i\)/));
});
