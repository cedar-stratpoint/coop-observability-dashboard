import Anthropic from '@anthropic-ai/sdk';
import {getDigests} from '@/src/data';
import {buildDigestBlock, buildLiveContextBlock, buildStaticSystem} from '@/src/chat/context';
import {CHAT_EFFORT, COOP_CHAT} from '@/src/chat/config';
import {turnBudgetFromEnv} from '@/src/chat/cost';
import {CHAT_DEADLINE_MS, runChatLoop, SAFE_ERROR_TEXT} from '@/src/chat/loop';
import {encodeEvent} from '@/src/chat/stream-protocol';
import {dashboardLinks, pageContextLine, readPageInput} from '@/src/chat/pages';
import {buildDegradedPreamble, buildPreamble, digestIndexLine} from '@/src/chat/preamble';
import {openReportSession} from '@/src/chat/report-session';
import {chatTools} from '@/src/chat/tool-defs';
import {resolveCrmAccess} from '@/src/chat/crm/config';
import {createCrmClient, type CrmClient} from '@/src/chat/crm/client';
import {setupExplore} from '@/src/chat/explore-setup';
import {createExecutors} from '@/src/chat/tool-executors';
import {getChatDigest, getChatDigestIndex, getChatMetricDataOrDegrade} from '@/src/chat/server';
import type {ChatStreamEvent} from '@/src/chat/stream-types';
import {auth} from '@/auth';
import {websiteOrdersForReport} from '@/src/chat/crm/executors';
import {getActiveContext} from '@/src/active-context';
import {devAuthEnabled, DEV_SESSION} from '@/src/dev-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Minimal in-memory sliding-window rate limit (per IP). Cold-start reset is fine.
const HITS = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
function rateLimited(ip: string, now: number): boolean {
  const fresh = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  fresh.push(now);
  HITS.set(ip, fresh);
  return fresh.length > MAX_PER_WINDOW;
}

type InMsg = {role: 'user' | 'assistant'; content: string};

export async function POST(req: Request) {
  const started = Date.now();
  const session = devAuthEnabled() ? DEV_SESSION : await auth();
  if (!session?.user) return new Response('Please sign in to use Coop.', {status: 401});

  // Ask Coop reads Zoomy digests (no company dimension), so fence it to Zoomy:
  // a non-Zoomy viewer (Goldline / data-blind Coop Admin) must not query it. Skipped
  // under dev-auth bypass so the bypass never consults auth() (keeps that invariant).
  if (!devAuthEnabled()) {
    const chatCtx = await getActiveContext();
    if (chatCtx && chatCtx.companyId !== 'zoomy') {
      return new Response('Ask Coop is only available for Zoomy.', {status: 403});
    }
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new Response('Coop chat is not configured (missing API key).', {status: 503});

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (rateLimited(ip, Date.now())) return new Response('Too many requests — give Coop a moment.', {status: 429});

  let body: {messages?: InMsg[]; week?: string; home?: boolean; report?: unknown; page?: unknown};
  try {
    body = await req.json();
  } catch {
    return new Response('Bad request.', {status: 400});
  }

  // Sanitize + cap the conversation the client sends back.
  const raw = body !== null && typeof body === 'object' && Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m): m is InMsg => m !== null && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() !== '')
    .slice(-12)
    .map((m) => ({role: m.role, content: m.content.slice(0, 2000)}));
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return new Response('No question provided.', {status: 400});
  }

  // Live POS data is fail-closed: where the read path is not ready (production before the read-only database role is
  // applied, a missing secret, a failed load) the chat degrades to digest-only (no tools, no POS reads) instead of
  // going down. The reason is logged once as chat_degraded.
  const live = await getChatMetricDataOrDegrade();
  // Live mode is not anchored to any digest week: the owner defines the dates. Only degraded mode loads (masked) digests.
  const rows = live.ok ? [] : await getDigests(); // PII-masked server-side
  const now = new Date();
  const user = session.user.email ?? null;
  // F.2: the page the owner is on, and dashboard links pasted in the latest question. Untrusted input, validated here.
  const pageLine = pageContextLine(readPageInput(body.page), dashboardLinks(messages[messages.length - 1].content, new URL(req.url).host));
  // F.5: the stored digest windows (a narrow, cached read) ride in the per-turn preamble, so the model can ask for one by date.
  const digestLine = live.ok ? digestIndexLine(await getChatDigestIndex().catch(() => [])) : null;
  // F8: the open dashboard the drawer sends back. Untrusted: validated and re-run here; invalid or oversized is ignored
  // (one log line, no content). Digest-only mode has no tools, so a report is ignored there.
  const report = live.ok ? openReportSession(body.report, live.data, now, () => console.warn(JSON.stringify({event: 'chat_report_rejected'}))) : null;
  // Explore (run_query): fail-closed. Only an allowed user on a ready read path gets the tool, the prompt block and the executor.
  const explore = live.ok && report ? setupExplore({env: process.env, email: user, now, user, store: report.store}) : null;
  // Train 4: the GET-only website CRM client, one per request (its memo and caps are per turn). Fail-closed: no env, no client.
  const crmAccess = resolveCrmAccess(process.env);
  const crm: CrmClient | null = live.ok && crmAccess.enabled ? createCrmClient({baseUrl: crmAccess.baseUrl, token: crmAccess.token, fetch}) : null;
  const crmTools = crm !== null && crmAccess.enabled && crmAccess.tools;
  // get_channel_report reads live website (CRM) orders whenever the CRM client exists: the prompt's Website lines follow these flags.
  const website = crm !== null;
  const system = [
    {type: 'text' as const, text: buildStaticSystem({tools: live.ok, explore: explore !== null, crm: crmTools, website}), cache_control: {type: 'ephemeral' as const}},
    {type: 'text' as const, text: live.ok ? buildLiveContextBlock({explore: explore !== null, crm: crmTools, website}) : buildDigestBlock(rows, body.week, {home: body.home === true}), cache_control: {type: 'ephemeral' as const}},
  ];

  const anthropic = new Anthropic({apiKey: key});
  const coverage = explore ? await explore.coverageLine() : null;
  return ndjson((emit) =>
    runChatLoop({
      client: anthropic,
      model: COOP_CHAT.model,
      maxTokens: COOP_CHAT.maxTokens,
      effort: CHAT_EFFORT,
      system,
      tools: live.ok ? chatTools({explore: explore !== null, crm: crmTools}) : [],
      messages,
      preamble: live.ok && report ? buildPreamble(live.data, now, report.outline(), coverage, {explore: explore !== null, page: pageLine, digests: digestLine, flags: {website, crm: crmTools}}) : buildDegradedPreamble(now),
      executors:
        live.ok && report
          ? createExecutors({data: async () => live.data, now, user, emitBlock: (block) => emit({t: 'block', block}), report, emitReport: (spec) => emit({t: 'report', spec}), digest: getChatDigest, crmOrders: crm ? () => websiteOrdersForReport({client: crm, user}) : undefined, explore: explore?.executor, exploreSchema: explore?.schema, crm: crmTools && crm ? crm : undefined})
          : {},
      emit,
      user,
      // maxDuration is 60 s from the request, so the loop's 50 s budget loses what the digest and data loads already used.
      deadlineMs: Math.max(0, CHAT_DEADLINE_MS - (Date.now() - started)),
      signal: req.signal,
      exploreGap: explore?.executor.gap,
      turnBudget: turnBudgetFromEnv(process.env),
    }).then(() => undefined),
  );
}

/** One NDJSON response: run `work` with an emitter, always close the stream. */
function ndjson(work: (emit: (e: ChatStreamEvent) => void) => void | Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (e: ChatStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(e)));
        } catch {
          closed = true; // the client went away
        }
      };
      try {
        await work(emit);
      } catch {
        emit({t: 'error', message: SAFE_ERROR_TEXT});
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: {'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store'},
  });
}
