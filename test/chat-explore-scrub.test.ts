import {describe, expect, it} from 'vitest';
import {HIDDEN, scrubRows, scrubValue} from '../src/chat/explore/scrub';

const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
const skKey = 'sk-' + 'x9'.repeat(12);
const hex = 'f'.repeat(32);

describe('2.2 value scanner: secret-shaped values never reach the model (Review Focus 5)', () => {
  it('hides JWTs, API keys, PEM blocks and long hex inside text, keeping the rest', () => {
    expect(scrubValue(`token ${jwt} end`)).toEqual({value: `token ${HIDDEN} end`, hidden: 1});
    expect(scrubValue(skKey).value).toBe(HIDDEN);
    expect(scrubValue('sk_live_' + 'A1'.repeat(8)).value).toBe(HIDDEN);
    expect(scrubValue('pk_live_' + 'B2'.repeat(8)).value).toBe(HIDDEN);
    expect(scrubValue('pk_test_' + 'C3'.repeat(8)).value).toBe(HIDDEN);
    expect(scrubValue('sb_secret_' + 'q'.repeat(20)).value).toBe(HIDDEN);
    expect(scrubValue('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----').value).toBe(HIDDEN);
    expect(scrubValue('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----').value).toBe(HIDDEN);
    expect(scrubValue('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn').value).toBe(HIDDEN); // truncated block: hidden to the end
    expect(scrubValue('-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----').value).toBe(HIDDEN); // any PEM block
    expect(scrubValue(`fixture-token-${hex}`).value).toBe(`fixture-token-${HIDDEN}`);
    expect(scrubValue('fixture-token-4a8a08f09d37b73795649038408b5f33').value).toBe(`fixture-token-${HIDDEN}`); // the fixture's md5
    expect(scrubValue('a1B2'.repeat(11)).value).toBe(HIDDEN); // 44 mixed letters and digits, no separator
  });
  it('hides any JSON value under a secret-named key, at any depth', () => {
    expect(scrubValue({lazada: {access_token: 'abc', shop: 'Zoomy'}, price: 129.5})).toEqual({value: {lazada: {access_token: HIDDEN, shop: 'Zoomy'}, price: 129.5}, hidden: 1});
    expect(scrubValue([{api_key: 'x'}, {pinned: true}]).value).toEqual([{api_key: HIDDEN}, {pinned: true}]);
    expect(scrubValue({refresh_token: null, password: ''})).toEqual({value: {refresh_token: null, password: ''}, hidden: 0}); // nothing to hide
  });
  it('leaves ordinary values alone: prices, dates, uuids, names, short ids, urls without tokens', () => {
    for (const v of [129.5, 0, null, true, '2026-09-28', '2026-09-28T04:00:00+08:00', '3f2b9c1e-8d7a-4b6e-9f0a-1c2d3e4f5a6b', 'Dog treats 100g', 'P1', 'https://zoomy.ph/products/jerky', 'GCash', 'SM Aura bazaar 2026']) {
      expect(scrubValue(v), String(v)).toEqual({value: v, hidden: 0});
    }
  });
  it('no false-positive explosion: uuids, order numbers and long digit strings are never hidden', () => {
    const keep = [
      '3F2B9C1E-8D7A-4B6E-9F0A-1C2D3E4F5A6B', // upper-case uuid
      'lead 3f2b9c1e-8d7a-4b6e-9f0a-1c2d3e4f5a6b, 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', // two uuids in text
      '250928ABCD1234', // Shopee order sn
      '1234567890123456', // Lazada order number (16 digits)
      '12345678901234567890123456789012345678901234567890', // 50 digits: no letter, not a token
      '09171234567', // a PH mobile number
      'ZMY-2026-000123', // a POS reference
      'gid://shopify/Product/8123456789012',
      'SPEPH0123456789A', // a tracking number
      'pos_inventory_by_location_snapshot_2026_09_28', // long snake_case identifier
      'the-quick-brown-fox-jumps-over-the-lazy-dog-again-and-again',
      'Order 1234567890, total 1290.00, paid by GCash', // digits inside text
    ];
    for (const v of keep) expect(scrubValue(v), v).toEqual({value: v, hidden: 0});
    const rows = Array.from({length: 200}, (_, i) => [i, `3f2b9c1e-8d7a-4b6e-9f0a-${String(i).padStart(12, '0')}`, `2509${String(i).padStart(10, '0')}`, 'completed']);
    expect(scrubRows(rows).hidden).toBe(0);
  });
  it('scrubs whole result rows and counts what it hid', () => {
    expect(scrubRows([[1, jwt, 'ok'], [2, 'fine', {secret: 's'}]])).toEqual({rows: [[1, HIDDEN, 'ok'], [2, 'fine', {secret: HIDDEN}]], hidden: 2});
  });
});

describe('2.2 scanner, Task 7 review findings 1-3: JSON as text, glued prefixes, common secret shapes', () => {
  const h40 = 'f'.repeat(40);
  const hex32 = '4a8a08f09d37b73795649038408b5f33';
  it('finding 1: JSON that arrives as TEXT keeps the secret-named-key rule (jsonb::text, ->> of an object, row text, wrapped JSON)', () => {
    expect(scrubValue('{"api_key": "abc123short", "shop": "Zoomy"}')).toEqual({value: JSON.stringify({api_key: HIDDEN, shop: 'Zoomy'}), hidden: 1});
    expect(scrubValue('{"lazada": {"access_token": "tok"}}').value).toBe(JSON.stringify({lazada: {access_token: HIDDEN}}));
    expect(scrubValue('[{"password": "hunter2"}]').value).toBe(JSON.stringify([{password: HIDDEN}]));
    // not parseable as a whole (wrapped by concat, row text with doubled quotes): the key/value text rule still hides it
    expect(scrubValue('note: {"api_key": "abc123short", "shop": "Zoomy"}')).toEqual({value: `note: {"api_key":"${HIDDEN}","shop":"Zoomy"}`, hidden: 1});
    expect(scrubValue('(1,"{""refresh_token"": ""xyz"", ""shop"": ""Z""}")')).toEqual({value: `(1,"{""refresh_token"": ""${HIDDEN}"", ""shop"": ""Z""}")`, hidden: 1});
    expect(scrubValue('{"secret": 12345, "n": 1').value).toBe(`{"secret": ${HIDDEN}, "n": 1`);
    // nothing to hide: the text is returned as it was (formatting kept)
    expect(scrubValue('{"shop": "Zoomy",  "threshold": 5}')).toEqual({value: '{"shop": "Zoomy",  "threshold": 5}', hidden: 0});
    expect(scrubValue('{"refresh_token": null, "password": ""}').hidden).toBe(0);
  });
  it('finding 2: a token glued to a prefix by _ is still hidden (no \\b between _ and the run)', () => {
    expect(scrubValue(`key_${h40}`).value).toBe(`key_${HIDDEN}`);
    expect(scrubValue(`shpat_${hex32}`).value).not.toContain(hex32);
    expect(scrubValue(`shpss_${hex32}`).value).not.toContain(hex32);
    expect(scrubValue('shpca_AbCd1234EfGh5678IjKl9012MnOp').value).toBe(HIDDEN);
    expect(scrubValue('re_AbCd1234_EfGh5678IjKl9012MnOpQr').value).toBe(HIDDEN);
    expect(scrubValue('AIza' + 'Sy0123456789abcdefABCDEF_-ghijklmn').value).toBe(HIDDEN);
    expect(scrubValue('GOCSPX-AbCd1234EfGh5678IjKl90').value).toBe(HIDDEN);
    expect(scrubValue('glpat' + '-AbCd1234EfGh5678IjKl').value).toBe(HIDDEN);
    expect(scrubValue('xoxe' + '-1-AbCd1234EfGh5678').value).toBe(HIDDEN);
    expect(scrubValue(`id_${'a1B2'.repeat(10)}`).value).toBe(`id_${HIDDEN}`);
  });
  it('finding 3: credential URLs, token query strings, bcrypt/argon2/crypt hashes, base64 with +/=, 32-char app secrets', () => {
    expect(scrubValue('postgres://coop:s3cret-pw@db.example.com:5432/app').value).toBe(`postgres://${HIDDEN}@db.example.com:5432/app`);
    expect(scrubValue('https://api.example.com/cb?access_token=abc123&shop=1').value).toBe(`https://api.example.com/cb?access_token=${HIDDEN}&shop=1`);
    expect(scrubValue('token=shortvalue').value).toBe(`token=${HIDDEN}`);
    expect(scrubValue('https://x.example/p?sign=ABC123&api_key=k1').value).toBe(`https://x.example/p?sign=${HIDDEN}&api_key=${HIDDEN}`);
    expect(scrubValue('$2b$12$' + 'R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW').value).toBe(HIDDEN);
    expect(scrubValue('$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo').value).toBe(HIDDEN);
    expect(scrubValue('$6$rounds=5000$saltsalt$' + 'Ab1/'.repeat(10)).value).toBe(HIDDEN);
    expect(scrubValue('dGhpcyBpcyBhIHNlY3JldCB2YWx1ZSB0aGF0IGlz+bG9uZw==').value).toBe(HIDDEN);
    expect(scrubValue('Xy7kQ2mN9pLr4sTv8wZa1bCd5eFg3hJk').value).toBe(HIDDEN); // 32 mixed: the Lazada app_secret shape
    expect(scrubValue('xy7kq2mn9plr4stv8wza1bcd5efg3hjk').value).toBe(HIDDEN); // 32 lower + digits
  });
  it('no false positives from the new shapes: uuids, SKUs, order numbers, dates, emails, phones, prices, image urls, words', () => {
    const keep = [
      '3f2b9c1e-8d7a-4b6e-9f0a-1c2d3e4f5a6b',
      'ZMY-JERKY-100G-CHICKEN', 'SKU_DOGTREATS_100G_2026', 'ZOOMYCHICKENJERKY100GPACKOFTWELVE01', // 35 upper + digits: a long SKU
      '250928ABCD1234', '1234567890123456', 'SPEPH0123456789A',
      '2026-09-28', '2026-09-28T04:00:00+08:00', '28/09/2026',
      'juan.delacruz1990@example.com', 'shop.orders+lazada@example.org', '+63 917 123 4567', '09171234567',
      '₱1,290.00', 'Price $12.50 each, $3$ off', 'P1,290 / 3 = 430',
      'https://cdn.shopify.com/s/files/1/0612/3456/7890/products/IMG1234.jpg?v=1696000000',
      'https://zoomy.ph/collections/all?page=2&sort_by=price-ascending&keyword=jerky',
      'https://zoomy.ph/p?utm_source=fb&utm_campaign=sept_sale',
      'monkey business: the key to a good treat is chicken',
      '{"shop": "Zoomy", "pinned": true, "keywords": ["jerky"]}',
      'internationalization_and_localization_settings_for_the_dashboard',
    ];
    for (const v of keep) expect(scrubValue(v), v).toEqual({value: v, hidden: 0});
  });
});

describe('2.2 scanner, Task 7 re-review R1/R2: camelCase keys, every JSON span parsed, escaped JSON decoded', () => {
  it('R1: camelCase / PascalCase / glued secret keys are hidden, parsed and as text', () => {
    for (const k of ['apiKey', 'accessToken', 'clientSecret', 'refreshToken', 'APIKey', 'apikey']) {
      expect(scrubValue({[k]: 'shorty', n: 1}), k).toEqual({value: {[k]: HIDDEN, n: 1}, hidden: 1});
      expect(scrubValue(`{"${k}": "shorty", "n": 1}`), k).toEqual({value: JSON.stringify({[k]: HIDDEN, n: 1}), hidden: 1});
      expect(scrubValue(`{"${k}": "shorty", "n": 1`).value, k).not.toContain('shorty'); // cut short: the text fallback
    }
    expect(scrubValue({shopName: 'Zoomy', isPinned: true, keywords: ['jerky']}).hidden).toBe(0);
  });
  it('R2: a secret key over an object or array in text that is not JSON as a whole hides the WHOLE value', () => {
    expect(scrubValue('note: {"secret": {"nested": "shorty"}}')).toEqual({value: `note: {"secret":"${HIDDEN}"}`, hidden: 1});
    expect(scrubValue('note: {"tokens": ["a", "b"]}')).toEqual({value: `note: {"tokens":"${HIDDEN}"}`, hidden: 1});
    expect(scrubValue('{"tokens": {"lazada": "short"}},{"n": 1}').value).not.toContain('short"');
    // string_agg of several objects: each one is parsed on its own
    const agg = scrubValue('{"shop": "A", "token": "x1"},{"shop": "B", "apiKey": {"v": "x2"}}');
    expect(agg).toEqual({value: `{"shop":"A","token":"${HIDDEN}"},{"shop":"B","apiKey":"${HIDDEN}"}`, hidden: 2});
  });
  it('R2: escaped (double-encoded) JSON is decoded and scrubbed, as a whole value and inside prose or other JSON', () => {
    const enc = JSON.stringify(JSON.stringify({token: 'x', shop: 'Z'})); // jsonb string holding serialized JSON, read as ::text
    expect(scrubValue(enc)).toEqual({value: JSON.stringify(JSON.stringify({token: HIDDEN, shop: 'Z'})), hidden: 1});
    expect(scrubValue(`note: ${enc}`).value).not.toMatch(/\\"x\\"/);
    expect(scrubValue(`note: ${enc}`).hidden).toBe(1);
    const inner = JSON.stringify({payload: JSON.stringify({lazada: JSON.stringify({accessToken: 'deep'})})});
    expect(scrubValue(inner).value).not.toContain('deep');
    expect(scrubValue({payload: JSON.stringify({apiKey: 'p1'})}).value).toEqual({payload: JSON.stringify({apiKey: HIDDEN})});
  });
  it('R2: unicode-escaped keys are decoded by JSON.parse; a quoted value with an escaped quote is hidden whole', () => {
    expect(scrubValue('x{"api\\u005fkey": "shorty"}').value).not.toContain('shorty');
    expect(scrubValue('x{"api_key": "ab\\", c"}').value).not.toContain(' c"');
    expect(scrubValue('x{"api_key": "ab\\", c", "n": 1').value).not.toContain(' c"'); // cut short: escape-aware fallback
  });
  it('R2: text cut mid-span falls back to the pair rule; a cut object or array value is hidden to the end', () => {
    expect(scrubValue('note: {"secret": {"nested": "shorty", "m"').value).toBe(`note: {"secret": ${HIDDEN}`);
    expect(scrubValue('note: {"token": ["a", "b"').value).toBe(`note: {"token": ${HIDDEN}`);
  });
  it('R2: the scan is bounded: huge or bracket-heavy text returns quickly and still gets the text rules', () => {
    const big = '{'.repeat(200_000) + '"token": "zz"';
    const t0 = Date.now();
    const r = scrubValue(big);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(String(r.value)).not.toContain('zz');
    // past the decode bound the value fails closed (round 2 N1): hidden, not handed to the text rules
    const deep = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({a: 1})))))));
    const d = scrubValue(deep);
    expect(d.hidden).toBe(1);
    expect(String(d.value)).toContain(HIDDEN);
    expect(String(d.value)).not.toMatch(/a\\*"\s*:\s*1/);
  });
  it('no regressions from the span scan: ordinary prose, brackets and JSON keep their text', () => {
    for (const v of ['price [PHP] {promo}', 'see [1] and {x}', '"quoted" words', '{"shop": "Zoomy",  "threshold": 5}', '[1, 2, 3]',
      'he said "{not json}"', '{"note": "the key to it"}']) {
      expect(scrubValue(v), v).toEqual({value: v, hidden: 0});
    }
  });
});

describe('2.2 scanner, Task 7 re-review round 2 N1-N5: past a bound it fails closed; the cut-short fallback; credential keys; linear time', () => {
  const enc1 = '"{\\"token\\":\\"shorty\\"}"'; // a double-encoded value, as jsonb::text of a jsonb string shows it
  const noLeak = (v: unknown, label: string) => {
    const r = scrubValue(v);
    expect(JSON.stringify(r.value), label).not.toContain('shorty');
    expect(r.hidden, label).toBeGreaterThan(0);
    return r;
  };
  it('N1: more than the span bound, then a double-encoded secret: the unscanned rest is hidden', () => {
    noLeak('{"a":1},'.repeat(201) + enc1, 'string_agg of 201 objects');
    noLeak('"q",'.repeat(201) + enc1, '201 quoted strings');
    // a form only the parse can judge (a \u-escaped key inside double-encoded JSON): past the bound it must still be hidden, which
    // proves the rest is hidden rather than left to the text rules
    const encU = JSON.stringify('{"\\u0074oken":"shorty"}');
    expect(scrubValue(encU).value).not.toContain('shorty'); // inside the bounds the parse decodes the key
    noLeak('{"a":1},'.repeat(201) + encU, 'span bound, escaped key');
    noLeak('['.repeat(30) + 'b'.repeat(60_000) + ' ' + encU, 'step bound, escaped key');
    const r = scrubValue('{"a":1},'.repeat(201) + encU);
    expect(String(r.value).startsWith('{"a":1},'.repeat(200))).toBe(true); // the judged head stays readable
    expect(String(r.value).endsWith(HIDDEN)).toBe(true);
  });
  it('N1: a cell over the length bound is cut before any scan and the rest is hidden; the scanned head stays readable', () => {
    // the padding has word breaks: a cut that does not split a run keeps the whole head (a split run is hidden whole, K2 below)
    const r = noLeak('xxxx '.repeat(20_000) + 'x ' + enc1, 'over 100k, then encoded');
    expect(String(r.value).startsWith('xxxx '.repeat(200))).toBe(true);
    expect(String(r.value).endsWith(HIDDEN)).toBe(true);
    noLeak(JSON.stringify(JSON.stringify({pad: 'a'.repeat(100_001), token: 'shorty'})), 'large double-encoded jsonb');
    noLeak('x'.repeat(100_001) + ' {"$token":"shorty"}', 'over 100k, unusual key');
    expect(scrubValue('plain words '.repeat(8_000))).toEqual({value: 'plain words '.repeat(8_000), hidden: 0}); // under the bound: untouched
  });
  it('N1: the step budget used up below the length bound hides the unscanned rest', () => {
    noLeak('['.repeat(30) + 'b'.repeat(60_000) + ' ' + enc1, 'unclosed openers');
  });
  it('N1: JSON encoded past the decode bound is hidden, not handed to the text rules', () => {
    let v: string = JSON.stringify({token: 'shorty'});
    for (let k = 0; k < 8; k++) v = JSON.stringify(v);
    noLeak(v, '8 encodings');
  });
  it('N2: cut-short JSON: escaped quotes, keys with $ : @, and an unterminated value under a secret key', () => {
    noLeak('"{\\"token\\":\\"shorty\\"', 'cut and escaped');
    noLeak('"{\\"a\\":\\"{\\\\\\"token\\\\\\":\\\\\\"shorty', 'cut, encoded twice');
    noLeak('x {"$token":"shorty"', '$ key');
    noLeak('x {"lazada:token":"shorty"', ': key');
    noLeak('x {"@token":"shorty"', '@ key');
    expect(scrubValue('x {"token": "shorty and more')).toEqual({value: `x {"token": ${HIDDEN}`, hidden: 1});
    noLeak('x {"shop": {"token": "shorty"', 'a kept object value does not shield the pair inside it');
    noLeak('(1,"{""shop"": {""token"": ""shorty""', 'row literal, the same');
    expect(scrubValue('x {"shop": "Zoomy", "n": 1')).toEqual({value: 'x {"shop": "Zoomy", "n": 1', hidden: 0});
  });
  it('N3: credential-bearing JSON keys are hidden, parsed and as text (request headers stored as jsonb)', () => {
    for (const k of ['Authorization', 'Proxy-Authorization', 'cookie', 'Cookie', 'Set-Cookie', 'bearer', 'passphrase', 'jwt', 'otp', 'cvv', 'cvc']) {
      expect(scrubValue({headers: {[k]: 'Bearer shorty'}}).value, k).toEqual({headers: {[k]: HIDDEN}});
      noLeak(`{"headers": {"${k}": "Bearer shorty"}}`, k);
      noLeak(`x {"${k}": "shorty"`, `${k} cut`);
    }
    expect(scrubValue('https://x.example/cb?cookie=shorty&n=1').value).toBe(`https://x.example/cb?cookie=${HIDDEN}&n=1`);
    expect(scrubValue({monkey: 1, isPinned: true, keyword: 'jerky', hashtag: '#zoomy'}).hidden).toBe(0);
  });
  it('N4: every rule is linear: a 100k-character cell of any shape scrubs in well under 500 ms', () => {
    const cells = ['ZM001'.repeat(20_000), 'a'.repeat(100_000), 'eyJ_'.repeat(25_000), '_eyJ'.repeat(25_000), 're_'.repeat(33_333),
      'a+'.repeat(50_000), 'a/'.repeat(50_000), 'sk-'.repeat(33_333), 'ab.'.repeat(33_333), '"a":'.repeat(25_000), '"token": '.repeat(11_111),
      '\\'.repeat(100_000), '{"a": '.repeat(16_666), 'x'.repeat(1_000_000)];
    for (const c of cells) {
      const t0 = performance.now();
      scrubValue(c);
      expect(performance.now() - t0, c.slice(0, 12)).toBeLessThan(500);
    }
  });
  it('N5: very deep nesting never returns the original value (hidden, not a stack overflow)', () => {
    const text = '['.repeat(10_000) + '{"token":"shorty"}' + ']'.repeat(10_000);
    noLeak(text, 'deep text');
    let o: unknown = {token: 'shorty'};
    for (let k = 0; k < 20_000; k++) o = [o];
    noLeak(o, 'deep parsed');
  });
});

describe('2.2 scanner, Task 7 re-review round 3 K1-K3: parsed keys are scanned; the cut never leaves a token prefix; long or escaped cut keys', () => {
  const noLeak = (v: unknown, label: string) => {
    const r = scrubValue(v);
    expect(JSON.stringify(r.value), label).not.toContain('shorty');
    expect(r.hidden, label).toBeGreaterThan(0);
    return r;
  };
  it('K1: keys of a PARSED value (jsonb arrives parsed) are scanned like values: token-shaped keys and JSON-text keys, at depth and in arrays', () => {
    expect(scrubValue({devices: {[jwt]: {platform: 'ios'}}})).toEqual({value: {devices: {[HIDDEN]: {platform: 'ios'}}}, hidden: 1});
    expect(scrubValue({sessions: {[hex]: 'active', other: 1}})).toEqual({value: {sessions: {[HIDDEN]: 'active', other: 1}}, hidden: 1});
    // a JSON-text key is scanned (shorty hidden inside it) AND is a secret NAME (its parts include token), so its value is hidden too
    expect(scrubValue({a: {'{"token":"shorty"}': 1}})).toEqual({value: {a: {'{"token":"[hidden]"}': HIDDEN}}, hidden: 2});
    expect(scrubValue({a: {'{"shop":"Z","sig":"shorty"}': 1}}).value).toEqual({a: {'{"shop":"Z","sig":"[hidden]"}': 1}}); // not a secret name: value kept
    expect(scrubValue([{[skKey]: 1}, {ok: [{[jwt]: 2}]}])).toEqual({value: [{[HIDDEN]: 1}, {ok: [{[HIDDEN]: 2}]}], hidden: 2});
    expect(scrubValue({[`sign=${'f'.repeat(20)}`]: 1}).value).toEqual({[`sign=${HIDDEN}`]: 1}); // the query-string rule on a key
    // the same objects as TEXT already hid the key (the text rules see the whole string): parsed and text now agree
    expect(scrubValue(JSON.stringify({sessions: {[hex]: 'active'}})).value).toBe(JSON.stringify({sessions: {[HIDDEN]: 'active'}}));
    // a secret-NAMED key is a name, not a value: it stays readable and its value is hidden, as before
    expect(scrubValue({api_key: 'shorty'})).toEqual({value: {api_key: HIDDEN}, hidden: 1});
  });
  it('K1: two keys hidden to the same marker both survive (the second is suffixed); a __proto__ key survives too (N6)', () => {
    expect(scrubValue({[hex]: 1, [jwt]: 2})).toEqual({value: {[HIDDEN]: 1, [`${HIDDEN} 2`]: 2}, hidden: 2});
    expect(scrubValue({[hex]: 1, [jwt]: 2, [skKey]: 3}).value).toEqual({[HIDDEN]: 1, [`${HIDDEN} 2`]: 2, [`${HIDDEN} 3`]: 3});
    const r = scrubValue(JSON.parse('{"__proto__": {"x": 1}, "token": "shorty"}'));
    expect(Object.keys(r.value as object)).toEqual(['__proto__', 'token']);
    expect(JSON.stringify(r.value)).toBe(`{"__proto__":{"x":1},"token":"${HIDDEN}"}`);
    expect(Object.getPrototypeOf(r.value)).toBeNull();
    expect(scrubValue('x {"__proto__": {"x": 1}, "token": "shorty"}').value).toBe(`x {"__proto__":{"x":1},"token":"${HIDDEN}"}`);
  });
  it('K1 (final review finding 7): 20,000 keys hidden to one marker are suffixed in linear time, and a literal suffixed key is never overwritten', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 20_000; i += 1) many[`${i.toString(16).padStart(8, '0')}${'c0ffee'.repeat(6)}`] = i; // 44 hex characters each, built at run time
    const t0 = performance.now();
    const r = scrubValue(many);
    const ms = performance.now() - t0;
    const keys = Object.keys(r.value as object);
    expect(keys).toHaveLength(20_000);
    expect(keys[0]).toBe(HIDDEN);
    expect(keys[19_999]).toBe(`${HIDDEN} 20000`);
    expect(ms).toBeLessThan(500);
    // a key that already reads "[hidden] 2" keeps its value; the next hidden key skips past it
    expect(scrubValue({[hex]: 1, [`${HIDDEN} 2`]: 'kept', [jwt]: 3}).value).toEqual({[HIDDEN]: 1, [`${HIDDEN} 2`]: 'kept', [`${HIDDEN} 3`]: 3});
  });
  it('K2: the 100,000-character cut never leaves the readable prefix of a run it splits: the whole run joins the hidden tail', () => {
    const pad = (n: number) => 'w '.repeat(n / 2); // word breaks, so only the run at the cut is in question
    const hex40 = 'a1b2c3d4e5'.repeat(4);
    const split20 = pad(99_980) + hex40; // the cut falls 20 characters into a 40-hex run
    expect(scrubValue(split20)).toEqual({value: pad(99_980) + HIDDEN, hidden: 1});
    const opaque = pad(99_960) + ' ' + 'Ab1'.repeat(13) + 'Z'; // a 40-character token cut one character short
    expect(scrubValue(opaque)).toEqual({value: pad(99_960) + ' ' + HIDDEN, hidden: 1});
    const jwtSplit = pad(99_990) + jwt; // the cut falls in the payload: no header, no payload prefix
    expect(scrubValue(jwtSplit)).toEqual({value: pad(99_990) + HIDDEN, hidden: 1});
    const url = pad(99_980) + 'postgres://coop:s3cret-pw@db.example.com/app'; // the cut falls inside the password
    expect(scrubValue(url)).toEqual({value: pad(99_980) + HIDDEN, hidden: 1});
    // the run ends exactly at the cut: complete, judged by the rules, and nothing before it is hidden
    const exact = pad(99_960) + hex40 + ' ' + 'tail words';
    expect(scrubValue(exact)).toEqual({value: pad(99_960) + HIDDEN + HIDDEN, hidden: 2});
    expect(scrubValue(pad(99_980) + 'readable words here and more')).toEqual({value: pad(99_980) + 'readable words here ' + HIDDEN, hidden: 1});
    // a cell that is one run of over 100,000 characters is hidden whole, not cut to a 100,000-character prefix
    expect(scrubValue('a'.repeat(100_001))).toEqual({value: HIDDEN, hidden: 1});
  });
  it('K3: the cut-short fallback reads keys over 64 characters and keys with backslash escapes', () => {
    noLeak('x {"lazada_seller_center_refresh_token_for_shop_12345_production_env_x":"shorty"', '66-character key');
    noLeak('x {"' + 'a'.repeat(500) + '_token":"shorty"', '500-character key');
    noLeak('x {"a\\_token":"shorty"', 'escaped underscore');
    noLeak('x {"a\\"token":"shorty"', 'escaped quote');
    noLeak('x {"tok\\nen_token":"shorty"', 'escaped newline');
    noLeak('x {"a\\\\token":"shorty"', 'escaped backslash');
    noLeak('"{\\"a\\\\_token\\":\\"shorty\\"', 'level 1, escaped underscore');
    noLeak('(1,"{""a\\_token"": ""shorty""', 'row literal, escaped underscore');
    // an escape never swallows the closing quote: the key ends at ITS quote, so the pair after a plain key is still judged ...
    expect(scrubValue('x {"a\\"b":"keep","token":"shorty"')).toEqual({value: `x {"a\\"b":"keep","token":"${HIDDEN}"`, hidden: 1});
    // ... and at escape level 1 the secret pair is the FIRST one, not a merged key ending at the last quote (which would leak shorty)
    noLeak('"{\\"token\\":\\"shorty\\",\\"shop\\":\\"Zoomy\\"', 'level 1, two pairs, cut');
    expect(scrubValue('x {"a\\"b":"keep","n":1')).toEqual({value: 'x {"a\\"b":"keep","n":1', hidden: 0});
  });
  it('K3: the fallback with escapes is still linear', () => {
    for (const c of ['"a\\"'.repeat(25_000), '"\\\\_token":'.repeat(10_000), '\\"'.repeat(50_000), '"' + 'a'.repeat(99_999)]) {
      const t0 = performance.now();
      scrubValue(c);
      expect(performance.now() - t0, c.slice(0, 12)).toBeLessThan(500);
    }
  });
});

describe('2.2 the result says what the scanner hid; base-table reads keep the Train 1 notes', () => {
  const limits = {maxRows: 200, maxCols: 12, maxBytes: 65536, timeoutMs: 5000, maxSqlChars: 2000, maxCallsPerQuestion: 5, maxPerUserDay: 100, modelRows: 50, maxRelations: 8, maxDepth: 20};
  const shape = async (relations: string[], hidden?: number) => {
    const {shapeResult} = await import('../src/chat/explore/result');
    const raw = {columns: [{name: 'pet', type: 'text' as const}, {name: 'leads_count', type: 'number' as const}], rows: [['dog', 3]], fetched: 1, ms: 1, ...(hidden === undefined ? {} : {hidden})};
    const r = shapeResult({raw, validated: {sql: 'select 1', relations, lints: [], columnRefs: []}, limits, id: 'x1'});
    if (!r.ok) throw new Error(r.code);
    return r.result.meta.caveats;
  };
  it('the count is a result check (values_hidden, warn), so the UI and the model see it as data', async () => {
    const {shapeResult} = await import('../src/chat/explore/result');
    const raw = {columns: [{name: 'note', type: 'text' as const}], rows: [['[hidden]']], fetched: 1, ms: 1, hidden: 2};
    const r = shapeResult({raw, validated: {sql: 'select 1', relations: ['pos_orders'], lints: [], columnRefs: []}, limits, id: 'x1'});
    expect(r.ok && r.result.meta.checks).toEqual([{code: 'values_hidden', status: 'warn', text: '2 values looked like a secret (key, token or hash) and were hidden.', values: {hidden: 2}}]);
    const none = shapeResult({raw: {...raw, hidden: 0}, validated: {sql: 'select 1', relations: ['pos_orders'], lints: [], columnRefs: []}, limits, id: 'x1'});
    expect(none.ok && none.result.meta.checks).toEqual([]);
  });
  it('a caveat counts the hidden values (singular and plural); none when nothing was hidden', async () => {
    expect(await shape(['pos_orders'], 1)).toContain('1 value looked like a secret (key, token or hash) and was hidden.');
    expect(await shape(['pos_orders'], 3)).toContain('3 values looked like a secret (key, token or hash) and were hidden.');
    expect((await shape(['pos_orders'], 0)).join(' ')).not.toMatch(/hidden/);
  });
  it('the leads note follows the base table spin_wheel_leads, not only the coop_explore_event_leads alias', async () => {
    expect(await shape(['spin_wheel_leads'])).toContain('Leads are booth sign-ups, not buyers.');
    expect(await shape(['coop_explore_event_leads'])).toContain('Leads are booth sign-ups, not buyers.');
  });
});
