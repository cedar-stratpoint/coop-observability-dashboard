import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  EXPLORE_SECRET_COLUMN_EXCEPTIONS, EXPLORE_SECRET_PARTS, EXPLORE_TENANT_PREFIXES, EXPLORE_TENANT_TABLES,
  isClosedRelation, isSecretColumn, isSecretJsonKey, isSecretName,
} from '../src/chat/explore/secret-names';
import {EXPLORE_VIEW_NAMES} from '../src/chat/explore/views';

const SQL = readFileSync('supabase/coop_chat_explore_direct.sql', 'utf8');
const arrayOf = (fn: string): string[] => {
  const m = new RegExp(`function coop_explore_admin\\.${fn}\\(\\)[\\s\\S]*?array\\[([^\\]]*)\\]`).exec(SQL);
  if (!m) throw new Error(`${fn} not found in the SQL`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
};

describe('EXP secret names (spec 1.3): one rule, SQL and TS copies equal', () => {
  it('parts, tenant prefixes, tenant tables and column exceptions match the SQL', () => {
    expect(arrayOf('secret_parts')).toEqual([...EXPLORE_SECRET_PARTS]);
    expect(arrayOf('tenant_prefixes')).toEqual([...EXPLORE_TENANT_PREFIXES]);
    expect(arrayOf('tenant_tables')).toEqual([...EXPLORE_TENANT_TABLES]);
    expect(arrayOf('column_exceptions')).toEqual([...EXPLORE_SECRET_COLUMN_EXCEPTIONS]);
  });

  it('the SQL splits words and forms plurals exactly like the TS', () => {
    expect(SQL).toContain("regexp_split_to_array(lower(name), '[^a-z0-9]+')");
    expect(SQL).toContain("w.word in (p.part, p.part || 's', p.part || 'es')");
  });

  it('keeps the security-review guards (fix round 1): whole-row views, PG 16+, grant option, trigger timeout', () => {
    expect(SQL).toMatch(/where a2\.attrelid = deps\.oid[\s\S]*?is_secret_column\(t\.relname, a2\.attname\)/);
    expect(SQL).toContain("current_setting('server_version_num')::int < 160000");
    expect(SQL.match(/case when x\.is_grantable then '\*' else '' end/g)?.length).toBe(4);
    expect(SQL).toContain('when query_canceled then');
  });

  it('keeps the round-2 guards: definer-function views closed, a swallowed cancel fails closed', () => {
    // round 3 folded the definer rule into the non-pg_catalog function rule; prosecdef stays explicit
    expect(SQL).toMatch(/when 'pg_catalog\.pg_proc'::regclass then d\.refobjid[\s\S]*?p\.prosecdef or/);
    expect(SQL).toMatch(/when query_canceled then[\s\S]*?pg_event_trigger_ddl_commands\(\)[\s\S]*?revoke all on public\.%I from coop_explore_ro cascade/);
  });

  it('keeps the round-3 guards: any non-pg_catalog function (direct, operator, cast) closes a view; one revoke failing keeps the rest', () => {
    expect(SQL).toContain("when 'pg_catalog.pg_operator'::regclass then o.oprcode::oid");
    expect(SQL).toContain("when 'pg_catalog.pg_cast'::regclass then k.castfunc");
    expect(SQL).toContain("and (p.prosecdef or pn.nspname <> 'pg_catalog'))");
    expect(SQL).toMatch(/loop\s+begin -- one sub-block per relation[\s\S]*?revoke all on public\.%I from coop_explore_ro cascade[\s\S]*?exception when query_canceled or others then[\s\S]*?end;\s+end loop;/);
    expect(SQL).toContain("select jobname from cron.job where jobname = 'coop_explore_reapply'");
    expect(SQL).toContain('select coop_explore_admin.reapply_all();');
  });

  it('fix round 4: views are default-deny, granted only through the one view_allowlist()', () => {
    const allowlist = arrayOf('view_allowlist');
    const chatViews = ['coop_chat_bundles', 'coop_chat_digest', 'coop_chat_events', 'coop_chat_order_items',
      'coop_chat_orders', 'coop_chat_price_changes', 'coop_chat_prices', 'coop_chat_products',
      'coop_chat_sale_movements', 'coop_chat_stock_by_location', 'coop_chat_stock_config'];
    const expected = [...chatViews, ...EXPLORE_VIEW_NAMES, 'pos_inventory', 'pos_inventory_by_location', 'pos_orders_completed'];
    expect([...allowlist].sort()).toEqual([...expected].sort());
    expect(allowlist).toHaveLength(29);
    expect(new Set(allowlist).size).toBe(allowlist.length);
    // the one decision: a view not on the list is closed, and a closed relation gets no table or column grant
    expect(SQL).toContain("when c.relkind in ('v', 'm', 'f') and not (c.relname::text = any (coop_explore_admin.view_allowlist())) then 'view not allowlisted'");
    expect(SQL).toContain('closed := coop_explore_admin.closed_reason(rel) is not null;');
    expect(SQL).toContain("want_tab := case when closed or mixed then '{}'::text[] else array['SELECT'] end;");
    expect(SQL).toContain("want_cols := case when not closed and mixed then safe_cols else '{}'::text[] end;");
    // no other grant path: the only SELECT grants are apply_grants' two and the trigger-guarded default privileges
    const code = SQL.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    const grants = [...code.matchAll(/\bgrant\s+select\b[^;']*/gi)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(grants).toEqual([
      'grant select on public.%I to coop_explore_ro',
      'grant select (%s) on public.%I to coop_explore_ro',
      'grant select on tables to coop_explore_ro',
    ]);
    expect(code).toMatch(/create event trigger coop_explore_guard_ddl[\s\S]*?alter default privileges for role postgres in schema public grant select on tables to coop_explore_ro;[\s\S]*?exception when insufficient_privilege then\s+[\s\S]*?revoke select on tables from coop_explore_ro;/);
    // the second layer stays, and the drift helper names every view that is not allowlisted
    expect(SQL).toContain("when coop_explore_admin.reads_closed(c.oid) then");
    expect(SQL).toContain("format('view not allowlisted: %s (not readable until added)', c.relname)");
    expect(SQL).toContain('ADD A VIEW');
    expect(SQL).not.toMatch(/pg_sleep/);
  });

  it('fix round 5: a closed relation or secret column the login reads through PUBLIC loses PUBLIC SELECT, else a warning', () => {
    // effective access, column grants included (has_table_privilege is false for a column-only grant)
    expect(SQL).toContain("pg_catalog.has_any_column_privilege('coop_explore_ro', rel, 'SELECT')");
    expect(SQL).toContain("pg_catalog.has_column_privilege('coop_explore_ro', rel, a.attnum, 'SELECT')");
    // apply_grants: re-check, revoke from PUBLIC only, re-check, warn
    expect(SQL).toMatch(/if coop_explore_admin\.login_leak\(rel\) is not null then\s+execute format\('revoke select on public\.%I from public', r\.relname\);[\s\S]*?leak := coop_explore_admin\.login_leak\(rel\);\s+if leak is not null then\s+raise warning 'coop_explore_admin: % still readable by the login through role membership \(%\)'/);
    // it runs after the own-grant comparison, so an 'ok' relation is still checked (no early return before it)
    const body = /function coop_explore_admin\.apply_grants[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
    expect(body.match(/\breturn\b/g)).toHaveLength(3); // 'skipped', result, 'error'
    expect(body.indexOf("revoke select on public.%I from public")).toBeGreaterThan(body.indexOf("result := 'ok';"));
    // PUBLIC is the only other grantee ever revoked
    const code = SQL.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    const revokes = [...code.matchAll(/\brevoke\b[^;']*\bfrom\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(new Set(revokes)).toEqual(new Set(['public', 'coop_explore_ro']));
    expect(code).toMatch(/revoke all on schema coop_explore_admin from public/);
    // drift helpers report what is still readable, with the reason
    expect(SQL).toContain("format('still readable by the login: %s (%s)', c.relname, coop_explore_admin.login_leak(c.oid))");
    expect(SQL).toContain('STILL READABLE by the login');
    expect(SQL).toContain('select * from coop_explore_admin.readable_closed();');
  });

  it('matches whole word parts only', () => {
    for (const n of ['api_key', 'password_hash', 'refresh_token', 'marketplace_tokens', 'pin', 'PIN', 'client_secret', 'credentials', 'hashes', 'Api-Key']) {
      expect(isSecretName(n), n).toBe(true);
    }
    for (const n of ['shipping_fee', 'pinned', 'monkey', 'hashtag_count', 'keychain', 'tokenized_at', 'email', 'bundle', 'opening_cash', 'apikey']) {
      expect(isSecretName(n), n).toBe(false);
    }
  });

  it('Task 7 re-review R1: a JSON key keeps its case, so camelCase / PascalCase / UPPER / snake / kebab / glued secret keys are secret', () => {
    for (const k of ['apiKey', 'accessToken', 'clientSecret', 'refreshToken', 'AccessToken', 'APIKey', 'API_KEY', 'ACCESS_TOKEN', 'x-api-key',
      'api_key', 'refresh-token', 'pinCode', 'passwordHash', 'apikey', 'APIKEY', 'accesstoken', 'authtoken', 'refreshtoken', 'clientsecret',
      'passwd', 'pwd', 'signature', 'tokens', 'myToken2', 'x2token', 'md5hash']) {
      expect(isSecretJsonKey(k), k).toBe(true);
    }
    // the whole-word rule still holds for JSON keys: a secret part glued into another word is not a secret
    for (const k of ['monkey', 'pinned', 'isPinned', 'keyword', 'keywords', 'keychain', 'hashtagCount', 'tokenizedAt', 'shopName', 'threshold',
      'shipping_fee', 'skuKeyless', 'URLPath', 'id']) {
      expect(isSecretJsonKey(k), k).toBe(false);
    }
  });
  it('round 2 N3: credential words are secret as JSON keys (whole parts, camel / snake / kebab / glued), not as SQL columns', () => {
    for (const k of ['authorization', 'Authorization', 'Proxy-Authorization', 'proxyAuthorization', 'proxyauthorization', 'cookie', 'Cookie',
      'cookies', 'Set-Cookie', 'setCookie', 'setcookie', 'bearer', 'bearerToken', 'passphrase', 'walletPassphrase', 'jwt', 'userJwt', 'jwt_token',
      'otp', 'otpCode', 'OTP', 'cvv', 'cardCvv', 'cvc', 'CVC', 'authToken', 'auth_token']) {
      expect(isSecretJsonKey(k), k).toBe(true);
    }
    for (const k of ['monkey', 'isPinned', 'keyword', 'hashtag', 'authorName', 'author', 'bearing', 'otter', 'cvvx', 'cookiecutter']) {
      expect(isSecretJsonKey(k), k).toBe(false);
    }
    // the SQL column rule and its SQL twin are untouched
    for (const n of ['authorization', 'cookie', 'bearer', 'passphrase', 'jwt', 'otp', 'cvv', 'cvc']) expect(isSecretName(n), n).toBe(false);
  });
  it('R1 does not touch the SQL column rule: Postgres folds unquoted names, so camelCase stays one part there', () => {
    for (const n of ['apiKey', 'accessToken']) expect(isSecretName(n), n).toBe(false);
    expect(isSecretColumn('pos_settings', 'key')).toBe(false);
  });

  it('closes secret and tenant tables, never a Zoomy table', () => {
    for (const t of ['marketplace_tokens', 'api_keys', 'gl_sales', 'gl_stores', 'companies', 'company_users', 'company_user_audit', 'company_user_prefs']) {
      expect(isClosedRelation(t), t).toBe(true);
    }
    for (const t of ['pos_orders', 'pos_settings', 'coop_reports', 'spin_wheel_leads', 'digest_archive', 'lazada_orders', 'company', 'glossary']) {
      expect(isClosedRelation(t), t).toBe(false);
    }
  });

  it('pos_settings.key is the one reviewed exception', () => {
    expect(isSecretColumn('pos_settings', 'key')).toBe(false);
    expect(isSecretColumn('pos_orders', 'key')).toBe(true);
    expect(isSecretColumn('marketplace_tokens', 'access_token')).toBe(true);
    expect(EXPLORE_SECRET_COLUMN_EXCEPTIONS).toEqual(['pos_settings.key']);
  });
});
