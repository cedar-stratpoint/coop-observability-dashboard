// Shared contract for the Talk to Data chat stream and tool plumbing (F4 + F5). Types only, no logic.
// Design: knowledge/architecture/2026-10-01-talk-to-data-design.md §§ 3, 4, 7 (slice 1), 7b (F4, F5).
import type {ChatBlock} from './block-types';
import type {ReportSession} from './report-session';
import type {ReportSpec} from './report-types';

/** One line of the NDJSON response body of POST /api/chat. The report event is F8; saved reports are F9. */
export type ChatStreamEvent =
  | {t: 'status'; text: string} // short plain-language progress ("Looking at bundle sales")
  | {t: 'text'; d: string} // a text delta of the answer (markdown, may contain <suggest>/<go> tags)
  | {t: 'block'; block: ChatBlock} // a stat tile, chart or table bound by the server from a stored result (F7)
  | {t: 'report'; spec: ReportSpec | null} // F8: the report after this turn changed it (null = nothing open); the client keeps it and sends it back
  | {t: 'untrusted'} // Train 4: the answer may quote customer-entered text (CRM lists, Explore rows); the drawer renders its links as plain text
  | {t: 'done'; steps: number; usage: ChatUsage}
  | {t: 'error'; message: string};

export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A strict custom tool as sent to the Messages API. Every parameter is required; enums and sentinels, no optionals. */
export interface ToolDefinition {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  cache_control?: {type: 'ephemeral'};
}

/** What the tool executors need. `data` may be loaded lazily and is cached by the caller. */
export interface ChatToolContext {
  data: () => Promise<import('./result-types').MetricData>;
  /** F10: the stored digests, loaded lazily through the digest adapter. Absent means get_digest says it is unavailable. */
  digest?: () => Promise<import('./digest-lookup').DigestSource>;
  /** F.6: live CRM orders for get_channel_report's Website row, read lazily. Absent means the CRM is not connected. */
  crmOrders?: () => Promise<{orders: import('../custom-range').RangeOrder[]; asOf: string}>;
  now: Date;
  user: string | null;
  /** F7: the render tools call this with each block they bind; the route forwards it to the stream. */
  emitBlock?: (block: ChatBlock) => void;
  /** F8: the open report for this request (validated and hydrated by the route). Absent means an empty report. */
  report?: ReportSession;
  /** F8: called after every tool call that changed the report; the route forwards it to the stream as {t: 'report'}. */
  emitReport?: (spec: ReportSpec | null) => void;
  /** Explore: the run_query executor, present only for an allowed user (route-gated). Absent means the tool is not registered. */
  explore?: (input: unknown) => Promise<unknown>;
  /** list_tables / describe_table (Explore users only), built with the same read-only runner. */
  exploreSchema?: {list_tables: (input: unknown) => Promise<unknown>; describe_table: (input: unknown) => Promise<unknown>};
  /** Train 4: the GET-only website CRM client for this request; present only when the CRM is configured and CHAT_CRM_TOOLS is not off. Absent means the four CRM tools are not registered. */
  crm?: import('./crm/client').CrmClient;
  /** Where audit lines go (tests pass a fake). Absent means console. */
  sink?: import('./audit').AuditSink;
}
