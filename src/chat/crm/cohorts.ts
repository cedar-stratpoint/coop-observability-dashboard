// RET-10 Stage 9B: propose_crm_cohort, Ask Coop's cohort DRAFTS (knowledge/best-practices/chat-proposed-writes.md).
// The model only fills a closed form (group, name, an AND rule over the closed field list) or asks for suggestions. Code validates it
// with THE validator the hand builder and the save action use (readCohortInput), counts the preview with THE evaluator the Website CRM
// page uses (cohortPreview → matchesCohort over customerRows), and draws a block with Save cohort / Adjust the rule. This module has NO
// write path: no client, no action, no RPC. The only way a draft becomes a cohort is a person clicking Save cohort, which calls the 9A
// create action (src/customer-cohorts-actions.ts) as the signed-in user. The model is told, every time, that nothing was saved.
import {condText, ruleText, type CohortRule} from '../../crm-compute';
import {cohortLabel, cohortPreview, cohortSuggestions, labelTaken, readCohortInput, ruleUsesBday, ruleUsesContact, type CohortDraftInput, type CohortPreview, type CustomerCohort} from '../../customer-cohorts';
import type {CohortDraftBlock} from '../block-types';
import type {MetricError} from '../result-types';

export type ProposeRequest = {kind: 'draft'; draft: CohortDraftInput} | {kind: 'suggest'};

/** Suggestions drawn as one-click drafts per call (the rest are listed to the model with their counts). */
export const MAX_SUGGESTED_DRAFTS = 3;
const KEYS = ['suggest', 'group', 'name', 'rule'];
const USAGE = 'Pass {group, name, rule: {all: [{f, op, v}]}} to draft one cohort, or {suggest: true} alone for suggestions.';

/** The model's input, closed: only these keys. A draft goes through readCohortInput, the same check as the builder and the save action. */
export function readProposeInput(input: unknown): ProposeRequest | MetricError {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {error: USAGE};
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some((k) => !KEYS.includes(k))) return {error: `Use only these parameters: ${KEYS.join(', ')}. ${USAGE}`};
  if (o.suggest === true) {
    return Object.keys(o).length === 1 ? {kind: 'suggest'} : {error: `suggest true takes no other parameter. ${USAGE}`};
  }
  if (o.suggest !== undefined && o.suggest !== false) return {error: `suggest must be true or left out. ${USAGE}`};
  const v = readCohortInput(o);
  // The validator's message is in plain words (it names fields by their labels); the description maps labels to f codes.
  if ('error' in v) return {error: `Draft refused: ${v.error} Fix the draft and call again (fields and operators: see the tool description).`};
  return {kind: 'draft', draft: v};
}

const DRAFT_SAY =
  'This is a DRAFT and it is NOT saved. It is on screen with a Save cohort button (and Adjust the rule); only the owner can save it by clicking. ' +
  'Never say it was saved, created or added. Say the rule with these sentences (never field names or codes) and quote the counts from here.';
const BASIS = "Website CRM, live · counted by Coop's code, not by the AI · test orders excluded";

/** The block a person saves from. Every string in it came from code (sentences from condText) or from the validated draft. */
export function draftBlock(id: string, draft: CohortDraftInput, preview: CohortPreview, caveats: string[]): CohortDraftBlock {
  return {
    kind: 'cohort_draft',
    id,
    source: 'propose_crm_cohort',
    title: cohortLabel(draft),
    reliable: caveats.length === 0,
    caveats,
    basis: BASIS,
    draft: {group: draft.group, name: draft.name, rule: draft.rule},
    sentences: draft.rule.all.map(condText),
    preview,
  };
}

type Rows = Parameters<typeof cohortPreview>[0] & readonly Parameters<typeof cohortSuggestions>[0][number][];
export interface ProposeContext {
  /** Customer rows exactly as the Website CRM page builds them (customerRows), read through the GET-only CRM client. */
  rows: Rows;
  /** False when a contact source could not be read: then conditions on last contacted or times contacted match nobody. */
  contactKnown: boolean;
  /** RET-13A: false when the birthday voucher ledger could not be read: then a condition on the birthday voucher matches nobody. Absent = known. */
  bdayKnown?: boolean;
  saved: readonly CustomerCohort[];
  emit?: (block: CohortDraftBlock) => void;
  nextId: () => string;
}

const contactCaveat = (rule: CohortRule, known: boolean, bdayKnown = true): string[] => [
  ...(!known && ruleUsesContact(rule) ? ['A contact source could not be read, so the conditions on last contacted or times contacted match nobody in this preview.'] : []),
  ...(!bdayKnown && ruleUsesBday(rule) ? ['The birthday voucher ledger could not be read, so the condition on the birthday voucher matches nobody in this preview.'] : []),
];
const previewOut = (p: CohortPreview) => ({customers: p.customers, buyers: p.buyers, repeat_buyers: p.repeat, repeat_rate_pct: p.ratePct});

/** A draft label that is already saved: never a second draft of it (the save would be refused anyway). */
export function duplicateError(draft: CohortDraftInput, saved: readonly CustomerCohort[]): MetricError | null {
  if (!labelTaken(saved, draft)) return null;
  const prior = saved.find((c) => cohortLabel(c).toLowerCase() === cohortLabel(draft).toLowerCase());
  return {error: `A cohort named ${cohortLabel(draft)} already exists${prior ? ` (${ruleText(prior.rule)})` : ''}. Nothing was drafted. Read it with list_crm_customers cohort, or draft under another name.`};
}

/** Run a validated request over the rows: a draft (one block) or suggestions (up to MAX_SUGGESTED_DRAFTS blocks). Never writes. */
export function runPropose(req: ProposeRequest, ctx: ProposeContext): unknown {
  if (req.kind === 'draft') {
    const dup = duplicateError(req.draft, ctx.saved);
    if (dup) return dup;
    const preview = cohortPreview(ctx.rows, req.draft.rule);
    const caveats = contactCaveat(req.draft.rule, ctx.contactKnown, ctx.bdayKnown);
    const id = ctx.nextId();
    ctx.emit?.(draftBlock(id, req.draft, preview, caveats));
    return {
      draft: 'not saved',
      label: cohortLabel(req.draft),
      rule: ruleText(req.draft.rule),
      ...previewOut(preview),
      notes: caveats,
      shown: ctx.emit !== undefined,
      ...(ctx.emit ? {block: id} : {note: 'The draft could not be drawn here, so it cannot be saved from this chat. Say so.'}),
      say: DRAFT_SAY,
    };
  }
  const all = cohortSuggestions(ctx.rows, ctx.saved);
  const drawn = ctx.emit ? all.slice(0, MAX_SUGGESTED_DRAFTS) : [];
  const blocks = drawn.map((s) => {
    const id = ctx.nextId();
    ctx.emit?.(draftBlock(id, s.draft, cohortPreview(ctx.rows, s.draft.rule), []));
    return id;
  });
  return {
    suggestions: all.map((s, i) => ({label: cohortLabel(s.draft), rule: ruleText(s.draft.rule), buyers: s.buyers, repeat_buyers: s.repeat, repeat_rate_pct: s.ratePct, small_group: s.small, ...(i < blocks.length ? {block: blocks[i]} : {})})),
    basis: 'First-order codes with buyers that no saved cohort covers yet, biggest first. Group Promo is a placeholder: which code was which event is the owner\'s to say (they can rename before saving).',
    shown: blocks.length,
    say: all.length
      ? `The first ${blocks.length} are drawn as drafts with Save cohort buttons; none is saved. Never say any was saved. Offer to draft the others if asked.`
      : 'Every first-order code with buyers is already covered by a saved cohort: say so. Nothing was drafted.',
  };
}

