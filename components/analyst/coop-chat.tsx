'use client';

import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {useSearchParams, usePathname, useRouter} from 'next/navigation';
import {Sparkles, X, ArrowUp, Plus, Copy, Check, Square, RotateCcw, ArrowRight, AlertCircle, Maximize2, Minimize2} from 'lucide-react';
import {cn} from '@/lib/utils';
import {createLineDecoder} from '@/src/chat/stream-protocol';
import {ChatBlocks} from './chat-blocks';
import {interleave, sanitizeBlocks, type PlacedBlock} from './chat-blocks-format';
import {ChatMarkdown} from './chat-markdown';
import {applyStreamEvents, closeStream, startStream, StreamSlot} from './chat-stream-state';
import {describeFilters, reportBody, sanitizeReport} from './report-state';
import {ReportSaveBar} from './reports-save-bar';
import {lastUserPrompt, loadSavedRef, SAVED_KEY, serializeSavedRef} from './reports-helpers';
import type {ReportSpec} from '@/src/chat/report-types';
import type {SavedReportRef} from '@/src/reports-suggest';

// `blocks` (F7): stat tiles, charts and tables the server bound; `at` = length of the accumulated raw text when the block
// arrived, so the answer reads caveat, headline, block, then whatever streamed after it. `content` stays plain text.
type Msg = {role: 'user' | 'assistant'; content: string; error?: boolean; blocks?: PlacedBlock[]; untrusted?: true};
type NavAction = {label: string; path: string};

type Side = 'left' | 'right';
const CoopChatCtx = createContext<{ask: (q: string) => void; open: (side?: Side) => void; scopeLabel?: string; openReport: (spec: ReportSpec, saved: SavedReportRef | null) => void}>({
  ask: () => {},
  open: () => {},
  openReport: () => {},
});
export const useCoopChat = () => useContext(CoopChatCtx);

const STORE_KEY = 'coop-chat-v1';
const REPORT_KEY = 'coop-report-v1'; // F8: the open dashboard's spec
// F9: SAVED_KEY (coop-report-saved-v1) holds {id, version, spec} of this conversation's last Save/Update.
const SUGGESTIONS = [
  'Which channel has the best ROAS?',
  'What should I prioritize?',
  'Compare Shopee and Lazada ad spend.',
  'Which products are driving revenue?',
];
// Home screen: no period loaded yet, so orient the user instead.
const HOME_SUGGESTIONS = [
  'What can you help me with?',
  'How do I compare my channels?',
  'Where do I see ad spend and ROAS?',
  'What should I look at first?',
];

const ASSISTANT_BUBBLE =
  'max-w-[90%] overflow-hidden rounded-2xl border border-border bg-card px-3.5 py-2 text-[13.5px] leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_strong]:font-semibold [&_table]:my-1.5 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4';

/** True when message `i` or any earlier message used customer or Explore text: a link repeated in a later answer stays plain. */
function untrustedThrough(msgs: readonly {untrusted?: true}[], i: number): boolean {
  return msgs.slice(0, i + 1).some((x) => x.untrusted === true);
}

/** Read the stored conversation tolerantly: old entries have no blocks, malformed blocks are dropped, nothing throws. */
function loadMessages(raw: string): Msg[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const out: Msg[] = [];
  for (const m of parsed as Record<string, unknown>[]) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const blocks = sanitizeBlocks(m.blocks);
    out.push({role: m.role, content: m.content, ...(m.error === true ? {error: true} : {}), ...(m.untrusted === true ? {untrusted: true as const} : {}), ...(blocks.length ? {blocks} : {})});
  }
  return out;
}

const APP_PATHS = new Set(['/', '/traffic', '/health', '/repricer', '/offline-sales', '/offline-sales/orders', '/offline-sales/events', '/offline-sales/rankings', '/inventory', '/customers/all', '/customers/website-crm', '/customers/leads', '/customers/lazada', '/reports', '/?channel=all', '/?channel=shopee', '/?channel=lazada', '/?channel=website']);

/** Split a raw assistant message into visible text + follow-up suggestions + nav
 *  actions, tolerating partially-streamed hidden tags. */
function parseAssistant(raw: string): {text: string; suggestions: string[]; actions: NavAction[]} {
  const sm = raw.match(/<suggest>([\s\S]*?)<\/suggest>/);
  const suggestions = sm ? sm[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3) : [];

  const gm = raw.match(/<go>([\s\S]*?)<\/go>/);
  const actions: NavAction[] = gm
    ? gm[1]
        .split('||')
        .map((entry) => {
          const i = entry.indexOf('|');
          if (i < 0) return null;
          const label = entry.slice(0, i).trim();
          const path = entry.slice(i + 1).trim();
          return label && APP_PATHS.has(path) ? {label, path} : null;
        })
        .filter((a): a is NavAction => a !== null)
        .slice(0, 3)
    : [];

  const text = raw
    .replace(/<suggest>[\s\S]*?<\/suggest>/g, '')
    .replace(/<go>[\s\S]*?<\/go>/g, '')
    .replace(/<(?:suggest|go)[\s\S]*$/, '') // dangling partial while streaming
    .trim();
  return {text, suggestions, actions};
}

export function CoopChatProvider({children, scopeLabel}: {children: React.ReactNode; scopeLabel?: string}) {
  const [isOpen, setOpen] = useState(false);
  const [side, setSide] = useState<Side>('right');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const slotRef = useRef(new StreamSlot());
  // Latest messages for event handlers: a state updater must stay pure (Strict Mode runs it twice), so sending never happens inside one.
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  // F8: the open dashboard (latest spec the server sent). The ref is what requests read; the state drives the chips.
  const [report, setReportState] = useState<ReportSpec | null>(null);
  const reportRef = useRef<ReportSpec | null>(null);
  // Taken when a question is asked: Regenerate re-sends the same report and history so edits never stack.
  const askedRef = useRef<{history: Msg[]; report: ReportSpec | null} | null>(null);
  // F9: the saved report this conversation's dashboard belongs to (set by Save / Update / openReport), so the drawer can offer
  // Update instead of a second Save. Persisted alongside the dashboard and cleared with it.
  const [saved, setSavedState] = useState<SavedReportRef | null>(null);
  const setSaved = useCallback((ref: SavedReportRef | null) => {
    setSavedState(ref);
    try {
      if (ref) localStorage.setItem(SAVED_KEY, serializeSavedRef(ref));
      else localStorage.removeItem(SAVED_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  const setReport = useCallback(
    (spec: ReportSpec | null) => {
      reportRef.current = spec;
      setReportState(spec);
      try {
        if (spec) localStorage.setItem(REPORT_KEY, JSON.stringify(spec));
        else localStorage.removeItem(REPORT_KEY);
      } catch {
        /* ignore */
      }
      if (!spec) setSaved(null); // New chat, Clear dashboard: the next dashboard is a new report
    },
    [setSaved],
  );
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const week = searchParams.get('week') ?? undefined;
  // Home = the landing brief (no channel opened) → generic getting-started mode.
  const home = pathname === '/' && !searchParams.get('channel');

  // Persist the conversation across reloads. Persisting waits for the load: otherwise the empty initial list is written first
  // and (Strict Mode runs effects twice in dev) read back, wiping the saved chat.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setMessages(loadMessages(raw));
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(REPORT_KEY);
      const spec = raw ? sanitizeReport(JSON.parse(raw)) : null;
      reportRef.current = spec;
      setReportState(spec);
      // A saved reference only means something next to its dashboard.
      setSavedState(spec ? loadSavedRef(localStorage.getItem(SAVED_KEY)) : null);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(messages));
    } catch {
      /* ignore */
    }
  }, [messages, hydrated]);

  const send = useCallback(
    async (history: Msg[], reportAtSend: ReportSpec | null) => {
      const ctrl = slotRef.current.begin();
      setBusy(true);
      setMessages([...history, {role: 'assistant', content: ''}]);
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({messages: history.map(({blocks: _blocks, untrusted: _untrusted, ...rest}) => rest), week, home, report: reportBody(reportAtSend), page: {path: window.location.pathname, query: window.location.search.slice(1)}}),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          // Friendly copy per status; the raw body is the server's message.
          const raw = (await res.text().catch(() => '')) || '';
          const msg =
            res.status === 401
              ? 'Your session expired. Please refresh the page and sign in again.'
              : res.status === 429
                ? 'Coop is getting a lot of questions right now — give it a few seconds and try again.'
                : res.status === 503
                  ? raw.startsWith('Ask Coop is unavailable') ? raw : 'Coop isn’t configured yet (missing API key). Ping your admin.'
                  : raw || 'Coop is unavailable right now. Please try again.';
          setMessages([...history, {role: 'assistant', content: msg, error: true}]);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const decode = createLineDecoder();
        // Blocks can land in an earlier message (a follow-up edits the open dashboard in place), so work on the whole list.
        const last = history.length;
        let state = startStream([...history, {role: 'assistant', content: ''} as Msg], reportAtSend);
        const apply = (events: ReturnType<typeof decode>) => {
          const out = applyStreamEvents(state, last, events);
          state = out.state;
          if (out.effects.status !== undefined) setStatus(out.effects.status);
          if (out.effects.report) setReport(out.effects.report.spec);
          setMessages(state.messages);
        };
        while (!state.finished) {
          const {done, value} = await reader.read();
          if (ctrl.signal.aborted) return; // Stop or New chat: nothing more may touch the conversation
          if (done) {
            apply(decode(dec.decode(), true));
            break;
          }
          apply(decode(dec.decode(value, {stream: true})));
        }
        // The stream closed without a `done` or an `error` event (the host killed the function, the connection dropped): say so.
        const closed = closeStream(state, last);
        if (closed !== state) {
          state = closed;
          setMessages(state.messages);
        }
      } catch (e) {
        // A user-initiated stop keeps the partial answer; other errors show a bubble.
        if ((e as Error).name === 'AbortError') return;
        setMessages([...history, {role: 'assistant', content: `Something went wrong: ${(e as Error).message}`, error: true}]);
      } finally {
        // Only the request that is still current may reset the drawer: a stream that was aborted by New chat must not clear the
        // busy flag or the controller of the request that replaced it.
        if (slotRef.current.release(ctrl)) {
          setBusy(false);
          setStatus('');
        }
      }
    },
    [week, home, setReport],
  );

  const stop = useCallback(() => slotRef.current.abort(), []);

  const regenerate = useCallback(() => {
    if (busy) return;
    const prev = messagesRef.current;
    {
      // Drop the trailing assistant reply and re-send from the last user turn.
      let end = prev.length;
      while (end > 0 && prev[end - 1].role === 'assistant') end--;
      // The snapshot from ask() undoes in-place edits the dropped attempt made; after a reload there is none.
      const snap = askedRef.current;
      const history = snap && snap.history.length === end ? snap.history : prev.slice(0, end);
      if (!history.length || history[history.length - 1].role !== 'user') return;
      const before = snap && snap.history.length === end ? snap.report : reportRef.current;
      setReport(before);
      setMessages(history);
      void send(history, before);
    }
  }, [busy, send, setReport]);

  const ask = useCallback(
    (q: string) => {
      const question = q.trim();
      if (!question || busy) return;
      setOpen(true);
      const next: Msg[] = [...messagesRef.current, {role: 'user', content: question}];
      askedRef.current = {history: next, report: reportRef.current};
      setMessages(next);
      void send(next, reportRef.current);
    },
    [busy, send],
  );

  const open = useCallback((s: Side = 'right') => {
    setSide(s);
    setOpen(true);
  }, []);

  // F9: "Ask Coop about this report" on a report page. Starts a clean conversation about that report: the saved recipe becomes
  // the open dashboard and `ref` the saved reference, so Update targets the same report.
  const openReport = useCallback(
    (spec: ReportSpec, ref: SavedReportRef | null) => {
      slotRef.current.abort();
      setMessages([]);
      askedRef.current = null;
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {
        /* ignore */
      }
      setReport(spec);
      setSaved(ref);
      setSide('right');
      setOpen(true);
    },
    [setReport, setSaved],
  );

  // ⌘K / Ctrl+K opens Coop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const newChat = useCallback(() => {
    // A running stream must stop first, or its next chunk would call setMessages with the old conversation and bring it back.
    slotRef.current.abort();
    setBusy(false);
    setStatus('');
    setMessages([]);
    setReport(null);
    askedRef.current = null;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* ignore */
    }
  }, [setReport]);

  return (
    <CoopChatCtx.Provider value={{ask, open, scopeLabel, openReport}}>
      {children}
      {!isOpen && <CoopFab onOpen={() => open('left')} />}
      {isOpen && (
        <CoopChatDrawer
          messages={messages}
          busy={busy}
          side={side}
          scopeLabel={scopeLabel}
          home={home}
          onClose={() => setOpen(false)}
          onAsk={ask}
          onNewChat={newChat}
          onStop={stop}
          onRegenerate={regenerate}
          report={report}
          onClearReport={() => setReport(null)}
          saved={saved}
          onSaved={setSaved}
        />
      )}
    </CoopChatCtx.Provider>
  );
}

/** Always-visible floating "Ask coop" button, pinned bottom-left in the nav rail.
 *  Opens the chat on the LEFT so it doesn't cover right-side dashboard content. */
function CoopFab({onOpen}: {onOpen: () => void}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Ask coop"
      title="Ask coop"
      className="fixed bottom-4 left-3 z-[70] flex size-10 items-center justify-center overflow-hidden rounded-full border border-primary/50 bg-primary/10 text-primary shadow-sm transition-all hover:-translate-y-0.5 hover:bg-primary/15 hover:shadow-md max-md:hidden"
    >
      <span className="coop-shine" aria-hidden />
      <Sparkles className="size-4" />
    </button>
  );
}

/** The coop wordmark (lowercase, green second "o") — matches the top-left logo. */
function CoopWord() {
  return (
    <span className="font-extrabold tracking-tight">
      co<span style={{color: 'var(--primary)'}}>o</span>p
    </span>
  );
}

/** The compact top-bar entry point — a shine sweep glides across to draw the eye. */
export function AskCoopPill() {
  const {open} = useCoopChat();
  return (
    <button
      type="button"
      onClick={() => open('right')}
      className="relative inline-flex items-center gap-2 overflow-hidden rounded-full border border-primary/50 bg-primary/10 px-3.5 py-1.5 text-sm font-medium text-foreground transition-all hover:-translate-y-0.5 hover:bg-primary/15 hover:shadow-md"
    >
      <span className="coop-shine" aria-hidden />
      <Sparkles className="size-4 text-primary" />
      <span>
        Ask <CoopWord />
      </span>
    </button>
  );
}

function CopyButton({text}: {text: string}) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      aria-label="Copy"
      className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function CoopChatDrawer({
  messages,
  busy,
  side,
  scopeLabel,
  home,
  onClose,
  onAsk,
  onNewChat,
  onStop,
  onRegenerate,
  report,
  onClearReport,
  saved,
  onSaved,
}: {
  messages: Msg[];
  busy: boolean;
  side: Side;
  scopeLabel?: string;
  home?: boolean;
  onClose: () => void;
  onAsk: (q: string) => void;
  onNewChat: () => void;
  onStop: () => void;
  onRegenerate: () => void;
  report: ReportSpec | null;
  onClearReport: () => void;
  saved: SavedReportRef | null;
  onSaved: (ref: SavedReportRef) => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Full-screen toggle (md and up; on a phone the drawer is already full width). Remembered per browser.
  const [wide, setWide] = useState(false);
  useEffect(() => {
    try {
      setWide(localStorage.getItem('coop-chat-wide') === '1');
    } catch {
      /* storage unavailable: stay normal size */
    }
  }, []);
  const toggleWide = () =>
    setWide((w) => {
      try {
        localStorage.setItem('coop-chat-wide', w ? '0' : '1');
      } catch {
        /* not remembered */
      }
      return !w;
    });
  // In full screen the content keeps a readable column: side padding grows instead of wrapping every child.
  const gutter = wide ? 'md:px-[max(1rem,calc((100%-56rem)/2))]' : '';

  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: 'smooth'});
  }, [messages]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (wide ? setWide(false) : onClose());
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, wide]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    onAsk(draft);
    setDraft('');
  };

  const lastIdx = messages.length - 1;
  const empty = messages.length === 0;

  const composer = (
    <form onSubmit={submit} className="flex items-center gap-2">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={empty ? 'Ask coop anything…' : 'Ask a follow-up…'}
        aria-label="Message Coop"
        autoFocus
        className="min-w-0 flex-1 rounded-full border border-border bg-card px-4 py-2.5 text-[14px] text-foreground outline-none transition-colors focus:border-primary/50"
      />
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop"
          title="Stop"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Square className="size-3.5 fill-current" />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      )}
    </form>
  );

  // The open dashboard's chips plus (F9) its save bar. Shown in the empty state too: "Ask Coop about this report" opens the drawer
  // with a dashboard and no messages yet.
  const reportBar = report && (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="Open dashboard">
        {describeFilters(report.filters).map((c) => (
          <span key={c} className="rounded-full border border-border bg-card px-2 py-0.5 text-foreground">
            {c}
          </span>
        ))}
        <span className="text-muted-foreground">{report.blocks.length === 1 ? '1 block' : `${report.blocks.length} blocks`}</span>
        <button type="button" onClick={onClearReport} className="ml-auto text-muted-foreground/70 transition-colors hover:text-foreground">
          Clear dashboard
        </button>
      </div>
      <ReportSaveBar report={report} saved={saved} busy={busy} prompt={lastUserPrompt(messages)} onSaved={onSaved} onNavigate={onClose} />
    </>
  );

  return (
    <div className="fixed inset-0 z-[80]">
      <button aria-label="Close chat" onClick={onClose} className="absolute inset-0 bg-foreground/20 animate-in fade-in" />
      <aside
        role="dialog"
        aria-label="Chat with Coop"
        className={cn(
          'absolute top-0 flex h-full w-full flex-col bg-background shadow-2xl animate-in duration-300',
          wide ? 'max-w-none' : 'max-w-md',
          side === 'left' ? 'left-0 border-r border-border slide-in-from-left' : 'right-0 border-l border-border slide-in-from-right',
        )}
      >
        <header className={cn('flex items-center gap-2.5 border-b border-border p-4', gutter)}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-foreground">
              Chat with <CoopWord />
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {home ? 'Getting started — ask what you can do here' : scopeLabel ? `Answering about ${scopeLabel}` : 'Answers grounded in your store data'}
            </div>
          </div>
          {messages.length > 0 && (
            <button onClick={onNewChat} aria-label="New chat" title="New chat" className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Plus className="size-4" />
            </button>
          )}
          <button onClick={toggleWide} aria-label={wide ? 'Exit full screen' : 'Full screen'} title={wide ? 'Exit full screen (Esc)' : 'Full screen'} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:hidden">
            {wide ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>

        {empty ? (
          // Session start: greeting + suggestions + composer, vertically centered.
          <div className={cn('flex flex-1 flex-col justify-center gap-5 overflow-y-auto p-5', gutter)}>
            <p className="text-center text-[13px] text-muted-foreground">
              {home ? 'New here? Ask coop what you can do, or where to start.' : 'Ask coop about your sales, ads, products, or what to do next.'}
            </p>
            <div>
              {reportBar}
              {composer}
            </div>
            <div className="flex flex-col gap-2">
              {(home ? HOME_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button key={s} onClick={() => onAsk(s)} className="rounded-xl border border-border bg-card px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:border-primary/50 hover:bg-muted">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className={cn('flex-1 space-y-4 overflow-y-auto p-4', gutter)}>
              {messages.map((m, i) => {
                if (m.role === 'user') {
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3.5 py-2 text-[13.5px] leading-relaxed text-primary-foreground">{m.content}</div>
                    </div>
                  );
                }
                const {text, suggestions, actions} = parseAssistant(m.content);
                // Offsets were taken on the raw text; map each to the same point in the cleaned text (tags only trail it).
                const pieces = interleave(
                  text,
                  (m.blocks ?? []).map((b) => ({at: parseAssistant(m.content.slice(0, b.at)).text.length, block: b.block})),
                );
                const streamingThis = busy && i === lastIdx;
                if (m.error) {
                  return (
                    <div key={i} className="flex items-start gap-2 rounded-2xl border border-[color-mix(in_oklab,var(--status-crit)_35%,transparent)] bg-[color-mix(in_oklab,var(--status-crit)_8%,transparent)] px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" style={{color: 'var(--status-crit)'}} />
                      <span>{m.content}</span>
                    </div>
                  );
                }
                const isLastAssistant = i === lastIdx;
                return (
                  <div key={i} className="flex flex-col items-start">
                    {pieces.length === 0 ? (
                      <div className={ASSISTANT_BUBBLE}>{streamingThis ? <span className="text-muted-foreground">{status || 'Coop is thinking…'}</span> : null}</div>
                    ) : (
                      pieces.map((p, pi) =>
                        p.type === 'blocks' ? (
                          <div key={pi} className="my-2 w-full first:mt-0 last:mb-0">
                            <ChatBlocks blocks={p.blocks} />
                          </div>
                        ) : p.text.trim() ? (
                          <div key={pi} className={ASSISTANT_BUBBLE}>
                            <ChatMarkdown text={p.text} knownHostsOnly={untrustedThrough(messages, i) || (m.blocks ?? []).some((b) => b.block.exploratory === true)} />
                          </div>
                        ) : null,
                      )
                    )}
                    {streamingThis && pieces.length > 0 && status && <span className="mt-1 px-1 text-[12px] text-muted-foreground">{status}</span>}

                    {!streamingThis && actions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {actions.map((a) => (
                          <button
                            key={a.path + a.label}
                            onClick={() => router.push(a.path)}
                            className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                          >
                            {a.label} <ArrowRight className="size-3" />
                          </button>
                        ))}
                      </div>
                    )}

                    {!streamingThis && text && (
                      <div className="mt-1 flex items-center gap-3">
                        <CopyButton text={text} />
                        {isLastAssistant && (
                          <button onClick={onRegenerate} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground">
                            <RotateCcw className="size-3" /> Regenerate
                          </button>
                        )}
                      </div>
                    )}

                    {!streamingThis && suggestions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {suggestions.map((s) => (
                          <button key={s} onClick={() => onAsk(s)} className="rounded-full border border-primary/30 bg-primary/[0.06] px-2.5 py-1 text-[12px] text-primary transition-colors hover:bg-primary/10">
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className={cn('border-t border-border p-3', gutter)}>
              {reportBar}
              {composer}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
