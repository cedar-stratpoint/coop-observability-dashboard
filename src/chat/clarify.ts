// A clarifying question that ENDS the turn (plan knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md, A2/A3). Pure.
// A tool returns {clarify}; the loop writes the question itself and stops, so the model cannot skip it or guess past it.
// The options ride the drawer's existing <suggest> chips: a tap sends the option text as the owner's next message.

export interface Clarify {
  question: string;
  options: string[];
}
export interface ClarifyResult {
  clarify: Clarify;
}

/** Chips hold at most this many options (the drawer's <suggest> cap). */
export const MAX_OPTIONS = 5;

export function isClarify(v: unknown): v is ClarifyResult {
  if (v === null || typeof v !== 'object' || !('clarify' in v)) return false;
  const c = (v as {clarify: unknown}).clarify as Partial<Clarify> | null;
  return !!c && typeof c.question === 'string' && Array.isArray(c.options);
}

/** An option is data (product names are staff-typed): no chip separator, no tag brackets, one short line. */
const chip = (s: string): string => s.replace(/[|<>\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** The answer text: the question, then the hidden <suggest> line the drawer turns into tap chips. */
export function clarifyText(c: Clarify): string {
  const options = c.options.map(chip).filter(Boolean).slice(0, MAX_OPTIONS);
  const question = c.question.replace(/[<>]/g, ''); // may quote what the owner typed: never a tag
  return options.length > 0 ? `${question}\n\n<suggest>${options.join(' | ')}</suggest>` : question;
}

// ask_owner (A3): the model only picks WHAT is missing; the question and its choices are fixed here, so the owner always sees
// the same plain wording and the model cannot put words in a chip.
export const ASK_ABOUT = ['period', 'channel', 'comparison'] as const;
export type AskAbout = (typeof ASK_ABOUT)[number];

export const ASKS: Readonly<Record<AskAbout, Clarify>> = Object.freeze({
  period: {question: 'Which dates should I use? Pick one, or type the dates you want.', options: ['Last week', 'Last month', 'This week so far', 'All available data']},
  channel: {question: 'Which sales channel?', options: ['All channels', 'Offline (POS)', 'Shopee', 'Lazada', 'Website']},
  comparison: {question: 'What should I compare it with?', options: ['The previous period', 'Each channel side by side', 'Each event side by side']},
});

export function askOwner(input: unknown): ClarifyResult | {error: string} {
  const about = input !== null && typeof input === 'object' ? (input as {about?: unknown}).about : undefined;
  if (typeof about !== 'string' || !(ASK_ABOUT as readonly string[]).includes(about)) return {error: `about must be one of: ${ASK_ABOUT.join(', ')}.`};
  const c = ASKS[about as AskAbout];
  return {clarify: {question: c.question, options: [...c.options]}};
}
