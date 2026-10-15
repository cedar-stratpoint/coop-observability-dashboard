// The Train 3 attack suite (spec 2.9): the 25 chosen cases plus the rows the Task 7 fix rounds added, read by the validator and
// scanner test (test/chat-explore-attacks.test.ts, no database), the role proof (scripts/coop-explore-ro-proof.mjs, step (k)) and the
// scan integration test (test/chat-explore-scan.integration.test.ts, the real login through client.ts). Plain data.
// parser: what the SQL guard returns ('ok' = it passes the guard on purpose and another layer must stop it).
// db: MUST = the database alone refuses it (proof: M1, M2 and M3); PARSER = the guard is the layer that stops it (the database would
// run it); SCAN = it runs (validator bypassed), and the value scanner must hide what comes back. Every attack is blocked by at least
// one layer, many by two (a SCAN row the guard also refuses).
// scan (SCAN rows): raw = the rows the database returns for it (the integration test pins this model against the real database, so
// the no-database test of the scanner runs on true data); secrets = planted strings that are in raw and must be gone after the scan;
// visible = strings that must still read; maxMs = the cost bound; mayError = an E_DB_* refusal with no rows also counts as blocked.
// Planted values are fake (`shorty`, md5 of a letter); the fixture is scripts/coop-direct-fixture.sql (explore_fixture_notes,
// explore_fixture_payloads).
import {createHash} from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const S = 'shorty';
const P = 'explore_fixture_payloads';
const a = (id, category, sql, parser, db, scan) => ({id, category, sql, parser, db, ...(scan ? {scan} : {})});
/** to_jsonb(<text>)::text, n times: JSON-in-a-JSON-string (double-encoded). */
const enc = (sqlText, n) => {
  let e = sqlText;
  for (let i = 0; i < n; i++) e = `to_jsonb(${e})::text`;
  return e;
};
const encJs = (s, n) => {
  let e = s;
  for (let i = 0; i < n; i++) e = JSON.stringify(e);
  return e;
};
const TOKEN_JSON = '{"token":"shorty"}';
const NOTE1 = 'sk-' + 'x9'.repeat(12);
const NOTE2 = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
const NOTE3 = 'plain note 12345, nothing secret';
const NOTES_PAYLOAD1 = {lazada: {access_token: 'fixture-token-' + md5('d')}};
const NOTES_ROWS_TEXT = [
  `(1,${NOTE1},"{""lazada"": {""access_token"": ""fixture-token-${md5('d')}""}}")`,
  `(2,${NOTE2},{})`,
  `(3,"${NOTE3}","{""sku"": ""P1"", ""price"": 129.5}")`,
];
const NOTES_SECRETS = [NOTE1, NOTE2, md5('d')];
const ONE = (v) => [[v]];
/** jsonb::text of the fixture payloads (Postgres orders keys by length, then bytes, and writes ", " and ": "). */
const PT = {
  2: '{"apiKey": "shorty", "clientSecret": "s2"}',
  3: '{"tokens": {"lazada": "short"}}',
  4: '{"token": "shorty-planted-value"}',
  5: '{"token": "shorty"}',
  6: '{"$token": "shorty"}',
  7: '{"lazada:token": "shorty"}',
  8: '{"@token": "shorty"}',
  9: '{"apiKey": "shorty-unterminated"}',
  10: '{"shop": {"token": "shorty"}}',
  11: '{"headers": {"Cookie": "sid=shorty", "Set-Cookie": "x", "Authorization": "Bearer shorty"}}',
  12: '{"cvc": "shorty", "cvv": "shorty", "jwt": "shorty", "otp": "shorty", "bearer": "shorty", "passphrase": "shorty"}',
  13: '{"access_token": "shorty"}',
};
const ESC5 = JSON.stringify(PT[5]); // "{\"token\": \"shorty\"}"
const cutAfter = (text, needle) => text.indexOf(needle) + needle.length;
const AGG201 = Array.from({length: 201}, (_, i) => `{"n": ${1000 + i}}`).concat(JSON.stringify(TOKEN_JSON)).join(',');
const DEEP = '['.repeat(10000) + TOKEN_JSON + ']'.repeat(10000);
const deepJson = () => {
  let v = JSON.parse(TOKEN_JSON.replace(':', ': '));
  for (let i = 0; i < 10000; i++) v = [v];
  return v;
};
const HEADER_WORDS = ['bearer', 'passphrase', 'jwt', 'otp', 'cvv', 'cvc'];

export const DIRECT_READ_ATTACKS = [
  // ---- the 25 (plan Task 9) -------------------------------------------------------------------------------------------------
  a('A01', 'secret-table', 'select m.marketplace from marketplace_tokens m', 'E_RELATION', 'MUST'),
  a('A02', 'secret-column', 'select m.access_token from marketplace_tokens m', 'E_BLOCKED_COLUMN', 'MUST'),
  a('A03', 'schema-qualified', 'select m.marketplace from public.marketplace_tokens m', 'E_RELATION', 'MUST'),
  a('A04', 'quoted-case', 'select m.marketplace from "Marketplace_Tokens" m', 'E_RELATION', 'MUST'),
  a('A05', 'unicode-escape', 'select m.marketplace from U&"marketplace\\005ftokens" m', 'E_RELATION', 'MUST'),
  a('A06', 'mixed-star', 'select * from explore_fixture_mixed', 'E_SELECT_STAR', 'MUST'),
  a('A07', 'mixed-secret-column', 'select x.api_key from explore_fixture_mixed x', 'E_BLOCKED_COLUMN', 'MUST'),
  a('A08', 'mixed-whole-row', 'select x from explore_fixture_mixed x', 'E_SELECT_STAR', 'MUST'),
  a('A09', 'tenant', 'select s.store_code from gl_fixture_stores s', 'E_RELATION', 'MUST'),
  a('A10', 'tenant', 'select c.name from companies c', 'E_RELATION', 'MUST'),
  a('A11', 'other-schema', 'select u.email from auth.users u', 'E_RELATION', 'MUST'),
  a('A12', 'other-schema', 'select o.name from storage.objects o', 'E_RELATION', 'MUST'),
  a('A13', 'other-schema', 'select s.decrypted_secret from vault.decrypted_secrets s', 'E_BLOCKED_COLUMN', 'MUST'),
  a('A14', 'innocent-view', 'select v.marketplace from explore_fixture_token_view v', 'E_RELATION', 'MUST'), // the name has a part token
  a('A15', 'renamed-column-view', 'select v.label2 from explore_fixture_alias_view v', 'ok', 'MUST'),
  a('A16', 'secret-in-text', 'select n.id, n.note from explore_fixture_notes n order by n.id', 'ok', 'SCAN', {
    raw: [[1, NOTE1], [2, NOTE2], [3, NOTE3]], secrets: [NOTE1, NOTE2], visible: [NOTE3],
  }),
  a('A17', 'secret-in-json', 'select n.id, n.payload from explore_fixture_notes n where n.id = 1', 'ok', 'SCAN', {
    raw: [[1, NOTES_PAYLOAD1]], secrets: [md5('d')], visible: ['lazada', 'access_token'],
  }),
  a('A18', 'definer-write', 'select fake_write_rpc() as x from pos_orders o limit 1', 'E_FUNCTION', 'MUST'),
  a('A19', 'write', 'insert into pos_orders (total) values (1)', 'E_NOT_SELECT', 'MUST'),
  a('A20', 'set-role', 'set role postgres', 'E_NOT_SELECT', 'MUST'),
  a('A21', 'copy-program', "copy pos_orders to program 'true'", 'E_NOT_SELECT', 'MUST'),
  a('A22', 'copy-stdout', 'copy (select o.id from pos_orders o) to stdout', 'E_NOT_SELECT', 'PARSER'),
  a('A23', 'catalog-peek', "select c.column_name from information_schema.columns c where c.table_name = 'marketplace_tokens'", 'E_CATALOG', 'PARSER'),
  a('A24', 'catalog-peek', 'select a.attname from pg_attribute a', 'E_CATALOG', 'PARSER'),
  a('A25', 'file-read', "select pg_read_file('/etc/passwd') as x", 'E_FUNCTION_DENIED', 'MUST'),

  // ---- Task 7 fix round 1 (review findings 1, 4, 7) -------------------------------------------------------------------------
  a('A26', 'json-key-as-text', `select p.payload->>'api_key' as v from ${P} p where p.id = 1`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A27', 'json-key-as-text', `select jsonb_extract_path_text(p.payload, 'token') as v from ${P} p where p.id = 1`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A28', 'whole-row-text', 'select n::text as v from explore_fixture_notes n order by n.id', 'E_SELECT_STAR', 'SCAN', {
    raw: NOTES_ROWS_TEXT.map((t) => [t]), secrets: NOTES_SECRETS, visible: ['lazada', NOTE3],
  }),
  a('A29', 'whole-row-text', 'select concat(n) as v from explore_fixture_notes n order by n.id', 'E_SELECT_STAR', 'SCAN', {
    raw: NOTES_ROWS_TEXT.map((t) => [t]), secrets: NOTES_SECRETS, visible: ['lazada', NOTE3],
  }),
  a('A30', 'json-as-text', 'select n.payload::text as v from explore_fixture_notes n where n.id = 1', 'ok', 'SCAN', {
    raw: ONE(JSON.stringify(NOTES_PAYLOAD1).replace(/":/g, '": ')), secrets: [md5('d')], visible: ['lazada', 'access_token'],
  }),
  a('A31', 'json-object-as-text', "select n.payload->>'lazada' as v from explore_fixture_notes n where n.id = 1", 'ok', 'SCAN', {
    raw: ONE(JSON.stringify(NOTES_PAYLOAD1.lazada).replace(/":/g, '": ')), secrets: [md5('d')], visible: ['access_token'],
  }),
  a('A32', 'domain-cast', 'select o.id::explore_fixture_dom as v from explore_fixture_mixed o', 'E_CAST', 'PARSER'), // X58

  // ---- Task 7 fix round 2 (R1 camelCase keys, R2 JSON in text, R3) -----------------------------------------------------------
  a('A33', 'json-key-camel', `select p.payload->>'accessToken' as v from ${P} p where p.id = 1`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A34', 'json-key-camel', `select p.payload->>'apiKey' as v from ${P} p where p.id = 1`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A35', 'json-key-camel', `select p.payload->>'APIKey' as v from ${P} p where p.id = 1`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A36', 'json-key-camel', `select jsonb_extract_path_text(p.payload, 'lazada', 'refreshToken') as v from ${P} p where p.id = 1`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A37', 'json-text-camel', `select p.payload::text as v from ${P} p where p.id = 2`, 'ok', 'SCAN', {
    raw: ONE(PT[2]), secrets: [S, '"s2"'], visible: ['apiKey', 'clientSecret'],
  }),
  a('A38', 'json-text-nested', `select string_agg(p.payload::text, ',') as v from ${P} p where p.id = 3`, 'ok', 'SCAN', {
    raw: ONE(PT[3]), secrets: ['short'], visible: ['tokens'],
  }),
  a('A39', 'json-text-nested', `select concat('note: ', p.payload::text) as v from ${P} p where p.id = 3`, 'ok', 'SCAN', {
    raw: ONE('note: ' + PT[3]), secrets: ['short'], visible: ['note: ', 'tokens'],
  }),
  a('A40', 'double-encoded', `select to_jsonb(p.payload::text)::text as v from ${P} p where p.id = 2`, 'E_FUNCTION', 'SCAN', {
    raw: ONE(JSON.stringify(PT[2])), secrets: [S, '\\"s2\\"'], visible: ['apiKey'],
  }),
  a('A41', 'cut-short', `select left(p.payload::text, 30) as v from ${P} p where p.id = 4`, 'ok', 'SCAN', {
    raw: ONE(PT[4].slice(0, 30)), secrets: [S], visible: ['token'],
  }),

  // ---- Task 7 fix round 3 (N1 bounds fail closed, N2 cut and escaped, N3 credential keys, N4 cost, N5 nesting) -----------------
  a('A42', 'span-bound', `select string_agg(p.payload::text, ',' order by p.id) as v from ${P} p where p.id >= 1000`, 'ok', 'SCAN', {
    raw: ONE(AGG201), secrets: [S], visible: ['{"n": 1000}', '{"n": 1199}'],
  }),
  a('A43', 'char-bound', `select repeat('x', 100001) || ${enc(`'${TOKEN_JSON}'::text`, 1)} as v`, 'E_FUNCTION_DENIED', 'SCAN', {
    raw: ONE('x'.repeat(100001) + encJs(TOKEN_JSON, 1)), secrets: [S], maxMs: 5000, // a single run past the cap is hidden whole (K2)
  }),
  a('A44', 'char-bound', `select repeat('x', 100001) || ${enc(`'{"$token":"shorty"}'::text`, 1)} as v`, 'E_FUNCTION_DENIED', 'SCAN', {
    raw: ONE('x'.repeat(100001) + encJs('{"$token":"shorty"}', 1)), secrets: [S], maxMs: 5000,
  }),
  a('A45', 'step-bound', `select repeat('[', 30) || repeat('b', 60000) || ${enc(`'${TOKEN_JSON}'::text`, 1)} as v`, 'E_FUNCTION_DENIED', 'SCAN', {
    raw: ONE('['.repeat(30) + 'b'.repeat(60000) + encJs(TOKEN_JSON, 1)), secrets: [S], maxMs: 5000,
  }),
  a('A46', 'decode-bound', `select ${enc(`'${TOKEN_JSON}'::text`, 8)} as v`, 'E_FUNCTION', 'SCAN', {
    raw: ONE(encJs(TOKEN_JSON, 8)), secrets: [S],
  }),
  a('A47', 'cut-escaped', `select left(to_jsonb(p.payload::text)::text, ${cutAfter(ESC5, 'shorty\\"')}) as v from ${P} p where p.id = 5`, 'E_FUNCTION', 'SCAN', {
    raw: ONE(ESC5.slice(0, cutAfter(ESC5, 'shorty\\"'))), secrets: [S], visible: ['token'],
  }),
  a('A48', 'cut-odd-key', `select left(p.payload::text, ${PT[6].length - 1}) as v from ${P} p where p.id = 6`, 'ok', 'SCAN', {
    raw: ONE(PT[6].slice(0, -1)), secrets: [S], visible: ['$token'],
  }),
  a('A49', 'cut-odd-key', `select left(p.payload::text, ${PT[7].length - 1}) as v from ${P} p where p.id = 7`, 'ok', 'SCAN', {
    raw: ONE(PT[7].slice(0, -1)), secrets: [S], visible: ['lazada:token'],
  }),
  a('A50', 'cut-odd-key', `select left(p.payload::text, ${PT[8].length - 1}) as v from ${P} p where p.id = 8`, 'ok', 'SCAN', {
    raw: ONE(PT[8].slice(0, -1)), secrets: [S], visible: ['@token'],
  }),
  a('A51', 'cut-unterminated', `select left(p.payload::text, 20) as v from ${P} p where p.id = 9`, 'ok', 'SCAN', {
    raw: ONE(PT[9].slice(0, 20)), secrets: [S], visible: ['apiKey'],
  }),
  a('A52', 'cut-nested', `select left(p.payload::text, ${PT[10].length - 2}) as v from ${P} p where p.id = 10`, 'ok', 'SCAN', {
    raw: ONE(PT[10].slice(0, -2)), secrets: [S], visible: ['shop', 'token'],
  }),
  a('A53', 'credential-header', `select p.payload->'headers'->>'Authorization' as v from ${P} p where p.id = 11`, 'E_BLOCKED_COLUMN', 'PARSER'),
  a('A54', 'credential-header', `select p.payload::text as v from ${P} p where p.id = 11`, 'ok', 'SCAN', {
    raw: ONE(PT[11]), secrets: [S, 'sid=', 'Bearer', '"x"'], visible: ['Authorization', 'Set-Cookie'],
  }),
  ...HEADER_WORDS.map((w, i) => a(`A${55 + i}`, 'credential-key', `select p.payload->>'${w}' as v from ${P} p where p.id = 12`, 'E_BLOCKED_COLUMN', 'PARSER')),
  a('A61', 'credential-key', `select p.payload::text as v from ${P} p where p.id = 12`, 'ok', 'SCAN', {
    raw: ONE(PT[12]), secrets: [S], visible: HEADER_WORDS,
  }),
  a('A62', 'cost', "select repeat('ZM001', 20000) as v", 'E_FUNCTION_DENIED', 'SCAN', {raw: ONE('ZM001'.repeat(20000)), secrets: [], maxMs: 5000}),
  a('A63', 'cost', "select repeat('eyJ_', 25000) as v", 'E_FUNCTION_DENIED', 'SCAN', {raw: ONE('eyJ_'.repeat(25000)), secrets: [], maxMs: 5000}),
  a('A64', 'cost', "select repeat('re_', 33333) as v", 'E_FUNCTION_DENIED', 'SCAN', {raw: ONE('re_'.repeat(33333)), secrets: [], maxMs: 5000}),
  a('A65', 'deep-nesting', `select repeat('[', 10000) || '${TOKEN_JSON}' || repeat(']', 10000) as v`, 'E_FUNCTION_DENIED', 'SCAN', {
    raw: ONE(DEEP), secrets: [S], maxMs: 5000,
  }),
  a('A66', 'deep-nesting', `select (repeat('[', 10000) || '${TOKEN_JSON}' || repeat(']', 10000))::jsonb as v`, 'E_FUNCTION_DENIED', 'SCAN', {
    raw: [[deepJson()]], secrets: [S], maxMs: 5000, mayError: true,
  }),
];

/**
 * ACCEPTED LIMITS (knowledge/best-practices/chat-direct-read-access.md section 7, Task 7 review finding 4): NOT blocked, on purpose,
 * and pinned so a change in either direction is seen. The scanner bounds accidental exposure; SQL string functions can cut or rewrite
 * a value below every rule. The real controls for these are the name rule and the one-time column review. `scrubbed` = what the
 * scanner returns today (the value readable).
 */
const TOKEN40 = md5('t9') + md5('t10').slice(0, 8);
export const DIRECT_READ_RESIDUALS = [
  a('R01', 'accepted-limit:split', `select left(p.note, 20) as a, right(p.note, 20) as b from ${P} p where p.id = 20`, 'ok', 'RESIDUAL', {
    raw: [[TOKEN40.slice(0, 20), TOKEN40.slice(20)]], scrubbed: [[TOKEN40.slice(0, 20), TOKEN40.slice(20)]], whole: TOKEN40,
  }),
  a('R02', 'accepted-limit:key-rewrite', `select replace(p.payload::text, 'access_token', 'x') as v from ${P} p where p.id = 13`, 'ok', 'RESIDUAL', {
    raw: ONE('{"x": "shorty"}'), scrubbed: ONE('{"x": "shorty"}'), whole: PT[13],
  }),
];

/** Controls (not attacks): the accepted over-hiding (R3) and keys that must stay readable. `scrubbed` = the exact expected output. */
export const DIRECT_READ_CONTROLS = [
  a('C01', 'over-hide:key-value', `select p.payload as v from ${P} p where p.id = 14`, 'ok', 'CONTROL', {
    raw: ONE({key: 'color', value: 'red'}), scrubbed: ONE({key: '[hidden]', value: 'red'}),
  }),
  a('C02', 'over-hide:prose', `select p.note as v from ${P} p where p.id = 21`, 'ok', 'CONTROL', {
    raw: ONE('sort key=price'), scrubbed: ONE('sort key=[hidden]'),
  }),
  a('C03', 'over-hide:slug', `select p.note as v from ${P} p where p.id = 22`, 'ok', 'CONTROL', {
    raw: ONE('chickenjerkytreatsforsmalldogs100g'), scrubbed: ONE('[hidden]'),
  }),
  a('C04', 'readable-keys', `select p.payload as v from ${P} p where p.id = 15`, 'ok', 'CONTROL', {
    raw: ONE({monkey: 'banana', hashtag: 'zoomy', keyword: 'jerky', isPinned: true}), scrubbed: ONE({monkey: 'banana', hashtag: 'zoomy', keyword: 'jerky', isPinned: true}),
  }),
];
