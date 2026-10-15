import 'server-only';
import type {DigestArchiveRow} from '../types';
import {pickIndex, fmtRange} from '../week';
import {COOP_CHAT, buildGuardrails} from './config';
import {buildDataIndexText} from './catalog/prompt';
import {buildExamplesText} from './explore/examples';
import {buildStaticCatalog} from './preamble';
import {COOP_KNOWLEDGE} from './knowledge';
import {READ_ONLY_STATEMENT} from './read-only-statement';
import {renderSkill} from './skills/load';

// Reference facts (brand, glossary, ad products, policies) — appended to every
// prompt. Explicitly framed as background, NOT a source of live figures.
const KNOWLEDGE_BLOCK = [
  '',
  '## Brand knowledge base (reference — NOT live data)',
  'Use this to interpret the numbers and answer brand/definitional questions. Figures still come ONLY from a tool result or the digest; never quote a metric from here.',
  COOP_KNOWLEDGE,
].join('\n');

// Compact per-period trend row (numbers only) so Coop can answer "vs last month"
// without stuffing every full digest into context.
function trendRow(row: DigestArchiveRow): string {
  const range = fmtRange(row.window_from, row.window_to, row.digest.window?.label);
  const c = row.digest.comparison || {};
  const fmtCh = (k: 'shopee' | 'lazada' | 'website') => {
    const m = c[k];
    if (!m) return `${k}: n/a`;
    const parts = [
      m.revenue != null && `rev ₱${Math.round(m.revenue)}`,
      m.orders != null && `orders ${m.orders}`,
      m.adSpend != null && `adSpend ₱${Math.round(m.adSpend)}`,
      m.roas != null && `ROAS ${m.roas}×`,
    ].filter(Boolean);
    return `${k}: ${parts.join(', ')}`;
  };
  return `- ${range} — ${(['shopee', 'lazada', 'website'] as const).map(fmtCh).join(' | ')}`;
}

// Home ("getting started") mode: the user hasn't opened a period/channel, so no digest numbers are loaded.
// Offline POS questions still work through the tools.
function homeText(): string {
  return [
    '## Mode: getting started (home screen)',
    'The user is on the Coop home screen and has NOT opened a specific reporting period or channel yet, so no digest is loaded right now. Do NOT cite or invent any Shopee, Lazada or Website figures.',
    'You CAN answer questions about offline POS sales (revenue, orders, products, bundles, payments, pets, events) with your tools. For anything else, orient them and point them to where they can act:',
    '- Open **Sales** to see the unified cross-channel comparison (Shopee · Lazada · Website): revenue, orders, AOV, units, ad spend and ROAS, plus top products and recommended actions.',
    '- Use the **reporting-period picker** in the top bar to choose a timeframe.',
    '- **Marketing** (AI content studio) is coming soon.',
    'If they ask for Shopee, Lazada or Website numbers (e.g. "which channel has the best ROAS?"), tell them to open Sales (or pick a period) where the figures live, and offer to dig into it there. Keep replies warm and brief.',
  ].join('\n');
}

// Degraded mode (the live-data path is not available, e.g. production before the read-only database role is applied):
// no tools are sent and no POS data is read, so Coop answers from the digest only.
const NO_TOOLS_NOTICE =
  'Live offline POS data is not available right now and you have no tools. Answer only from the digest below. If asked about offline POS sales, products, bundles, payments or events, say plainly that this data is not available right now and offer what the digest can answer.';

/**
 * The STATIC, cached part of the system prompt: persona, guardrails, output format, brand knowledge and the metric
 * catalog. Byte-identical on every call (no dates, no digest, no counts) so the prompt cache holds.
 */
export function buildStaticSystem(opts: {tools?: boolean; explore?: boolean; crm?: boolean; website?: boolean} = {}): string {
  const withTools = opts.tools !== false;
  const explore = withTools && opts.explore === true; // Explore needs the tools path: it is never sent in digest-only mode
  const crm = withTools && opts.crm === true; // the CRM tools need the tools path too
  const website = withTools && (opts.website === true || crm); // the CRM can be read (get_channel_report's Website row is live)
  return [
    `You are ${COOP_CHAT.agentName}, ${COOP_CHAT.persona}`,
    '',
    '## Guardrails',
    buildGuardrails({explore, crm, website}),
    READ_ONLY_STATEMENT,
    `If a request is out of scope, reply exactly: "${COOP_CHAT.refusal}"`,
    '',
    '## Analyst skill',
    renderSkill({explore, crm}),
    '',
    '## Output format',
    COOP_CHAT.output,
    KNOWLEDGE_BLOCK,
    '',
    withTools ? buildStaticCatalog() : NO_TOOLS_NOTICE,
    // Explore adds its data index and worked examples INSIDE this (already cached) block: the request is at the 4-breakpoint limit.
    ...(explore ? ['', buildDataIndexText(), '', '## Worked exploratory queries', buildExamplesText()] : []),
  ].join('\n');
}

/**
 * The per-request digest block: the selected period's full (PII-masked) digest plus compact trend rows for the prior
 * periods, or the home-mode orientation text. `rows` come from getDigests() (already masked).
 */
export function buildDigestBlock(rows: DigestArchiveRow[], week?: string, opts?: {home?: boolean}): string {
  if (opts?.home) return homeText();
  const idx = rows.length ? pickIndex(rows, week) : -1;
  const current = idx >= 0 ? rows[idx] : null;
  const prior = idx >= 0 ? rows.slice(idx + 1, idx + 5) : []; // older periods
  const range = current ? fmtRange(current.window_from, current.window_to, current.digest.window?.label) : 'n/a';

  const lines = [
    `## Selected period: ${range}`,
    'Digest for this period (Shopee, Lazada and Website figures live here; offline POS figures come from tools):',
    '```json',
    current ? JSON.stringify(current.digest) : '{}',
    '```',
  ];
  if (prior.length) {
    lines.push('', '## Prior periods (compact: for trend/comparison questions only)', ...prior.map(trendRow));
  }
  return lines.join('\n');
}

/**
 * Live mode (tools available): NO period is pre-selected and no digest is loaded. The owner defines the dates; stored digests
 * are reachable only through get_digest, and only for the weeks that exist. Static text, so it is cache-friendly.
 */
export function buildLiveContextBlock(opts: {explore?: boolean; crm?: boolean; website?: boolean} = {}): string {
  return [
    '## Period',
    // The stock exception lives in THINK-01 only (one rule per behaviour): this line points to it.
    opts.explore
      ? 'No reporting period is selected for you: the owner chooses the dates. If a question asks for a figure for a period and names none, ask which dates before using any tool, except where THINK-01 says otherwise (stock). Another exception: a ranking, profile or "most/least" question with no period means all available data; run it over the whole range, say so in the answer, and offer a narrower period.'
      : 'No reporting period is selected for you: the owner chooses the dates. If a question has no period, ask which dates before using any tool, except where THINK-01 says otherwise (stock).',
    opts.crm
      ? 'Offline POS figures come from query_metric for any dates the data covers. Shopee and Lazada figures come from the stored digests (get_digest reads one window as published; get_channel_report totals any dates per channel); digest windows vary in length (weekly or about a month) and are listed in the per-turn context: name the window you used and say which dates no digest covers instead of guessing. Website orders, customers and abandoned checkouts come live from the CRM tools for any dates (list_crm_orders, list_crm_customers, list_crm_checkouts; get_crm_metrics for a snapshot); get_channel_report\'s Website row reads the same CRM orders.'
      : opts.website
        ? 'Offline POS figures come from query_metric for any dates the data covers. Shopee and Lazada figures come from the stored digests (get_digest reads one window as published; get_channel_report totals any dates per channel); Website totals for any dates come from live website orders through get_channel_report (its Website row reads live CRM orders), and get_digest reads the Website figures a digest published. Digest windows vary in length (weekly or about a month) and are listed in the per-turn context: name the window you used and say which dates no digest covers instead of guessing.'
        : 'Offline POS figures come from query_metric for any dates the data covers. Shopee, Lazada and Website figures come from the stored digests (get_digest reads one window as published; get_channel_report totals any dates per channel); digest windows vary in length (weekly or about a month) and are listed in the per-turn context: name the window you used and say which dates no digest covers instead of guessing.',
    `On the home screen, if asked what you can do, list what you can answer (offline POS metrics for any dates, channel digests by date, ${opts.crm ? 'website orders, customers and abandoned carts, ' : ''}dashboards and charts) and ask what they want to see and for which dates.`,
  ].join('\n');
}

/** The whole prompt as one string (static part, then the digest block). Kept for callers and tests that want one string. */
export function buildCoopSystemPrompt(rows: DigestArchiveRow[], week?: string, opts?: {home?: boolean}): string {
  return `${buildStaticSystem()}\n\n${buildDigestBlock(rows, week, opts)}`;
}
