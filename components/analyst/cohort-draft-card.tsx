'use client';

// RET-10 Stage 9B: a cohort DRAFT a person saves (knowledge/best-practices/chat-proposed-writes.md). One card for both places a draft
// shows: Ask Coop's answer (a `cohort_draft` block from propose_crm_cohort) and the Website CRM page's one-click suggestions. The rule is
// said as sentences (condText), never field codes; the counts come from code (the block's preview, or the page's own evaluator). The
// group and name can be renamed before saving. Save cohort calls the 9A create action as the signed-in user, which re-validates
// everything; nothing here runs without a click, and the model has no way to press it. Model output is rendered as React text only.
import {useId, useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Check, Pencil, Sparkles, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {REPEAT_TARGET_PCT, condText, readCohortRule, type CohortRule} from '@/src/crm-compute';
import {COHORT_GROUP_MAX, COHORT_NAME_MAX, cohortLabel, readCohortLabel, type CohortPreview} from '@/src/customer-cohorts';
import type {CohortDraftBlock} from '@/src/chat/block-types';
import {createCohort} from '@/src/customer-cohorts-actions';

export type CohortDraftValue = {group: string; name: string; rule: CohortRule};

const CRM_PAGE = '/customers/website-crm';
/** The Website CRM page with a saved cohort selected (after Save), or with the builder open on a draft (Adjust the rule). */
export const cohortHref = (id: string): string => `${CRM_PAGE}?cohort=${encodeURIComponent(id)}`;
export const adjustHref = (d: CohortDraftValue): string => `${CRM_PAGE}?cohort_draft=${encodeURIComponent(JSON.stringify(d))}`;

const field = 'h-8 min-w-0 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-primary';
const BTN = 'inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] disabled:opacity-50';

export function CohortDraftCard({
  draft,
  preview,
  intro,
  caveats = [],
  onAdjust,
  onDismiss,
  onSaved,
}: {
  draft: CohortDraftValue;
  /** Counted by code: the block's preview, or the page's evaluator over its own rows. */
  preview: CohortPreview;
  intro: string;
  caveats?: string[];
  onAdjust: (d: CohortDraftValue) => void;
  onDismiss?: () => void;
  /** Called with the saved (or already-saved) cohort's id. */
  onSaved?: (id: string) => void;
}) {
  const router = useRouter();
  const groupId = useId();
  const nameId = useId();
  const [group, setGroup] = useState(draft.group);
  const [name, setName] = useState(draft.name);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{id: string; label: string; already: boolean} | null>(null);

  const label = readCohortLabel({group, name});
  const rule = readCohortRule(draft.rule);
  const blocker = 'error' in label ? label.error : 'error' in rule ? rule.error : null;
  const sentences = 'rule' in rule ? rule.rule.all.map(condText) : [];
  const onTarget = preview.ratePct !== null && preview.ratePct >= REPEAT_TARGET_PCT;

  function save() {
    if ('error' in label || 'error' in rule) return;
    setError(null);
    start(async () => {
      const res = await createCohort({group: label.group, name: label.name, rule: rule.rule}, 'ask_coop');
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSaved({id: res.id, label: cohortLabel(label), already: res.already === true});
      onSaved?.(res.id);
      router.refresh();
    });
  }

  return (
    <section aria-label={`Draft cohort: ${cohortLabel({group, name})}`} className="flex w-full flex-col gap-3 rounded-2xl border border-primary/50 bg-card p-3">
      <header className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-start gap-1.5 text-[12px] leading-snug text-muted-foreground">
          <Sparkles className="mt-px size-3.5 shrink-0 text-primary" aria-hidden />
          <span>{intro}</span>
        </p>
        {onDismiss && !saved && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss this draft" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </header>

      {saved ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-foreground" role="status">
          <span className="inline-flex items-center gap-1 font-medium">
            <Check className="size-4 text-[var(--status-good)]" aria-hidden />
            {saved.already ? 'Already saved' : 'Saved'} as {saved.label}
          </span>
          <Link href={cohortHref(saved.id)} className="text-xs text-primary underline-offset-2 hover:underline">
            Open in the Website CRM
          </Link>
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <label htmlFor={groupId} className="block min-w-0">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Group</span>
            <input id={groupId} value={group} maxLength={COHORT_GROUP_MAX} onChange={(e) => setGroup(e.target.value)} className={cn(field, 'w-full')} />
          </label>
          <label htmlFor={nameId} className="block min-w-0">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Name</span>
            <input id={nameId} value={name} maxLength={COHORT_NAME_MAX} onChange={(e) => setName(e.target.value)} className={cn(field, 'w-full')} />
          </label>
        </div>
      )}

      <div>
        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Customers who match all of these</p>
        <ul className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
          {sentences.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-[10px] font-semibold uppercase text-muted-foreground">and</span>}
              <span className="rounded-md border border-border bg-[var(--card-warm)] px-2 py-0.5 text-foreground">{s}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground" aria-live="polite">
        <span>
          <b className="text-lg font-semibold tabular-nums text-foreground">{preview.customers.toLocaleString()}</b> {preview.customers === 1 ? 'customer matches' : 'customers match'} now
        </span>
        <span>
          Repeat buyer rate{' '}
          {preview.ratePct !== null ? (
            <b className={cn('font-semibold tabular-nums', onTarget ? 'text-[var(--status-good)]' : 'text-foreground')}>
              {preview.repeat} of {preview.buyers} buyers ({preview.ratePct.toFixed(1)}%)
            </b>
          ) : (
            <b className="font-semibold text-foreground">no buyers yet</b>
          )}{' '}
          · target {REPEAT_TARGET_PCT}%
        </span>
        {preview.names.length > 0 && (
          <span className="min-w-0 truncate">
            {preview.names.join(', ')}
            {preview.customers > preview.names.length ? '…' : ''}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Counted by Coop&apos;s code, not by the AI. Members update on every refresh.</p>
      {caveats.map((c, i) => (
        <p key={i} className="text-[11px] text-amber-700 dark:text-amber-300">
          {c}
        </p>
      ))}

      {!saved && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={pending || blocker !== null} className={cn(BTN, 'bg-primary text-primary-foreground hover:bg-primary/90')}>
            {pending ? 'Saving…' : 'Save cohort'}
          </button>
          <button
            type="button"
            onClick={() => 'rule' in rule && onAdjust({group, name, rule: rule.rule})}
            disabled={pending || 'error' in rule}
            className={cn(BTN, 'border border-border text-muted-foreground hover:border-primary hover:text-foreground')}
          >
            <Pencil className="size-3.5" aria-hidden /> Adjust the rule
          </button>
          {(error ?? blocker) && (
            <span role="alert" className="basis-full text-xs text-destructive">
              {error ?? blocker}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** Ask Coop's `cohort_draft` block in the drawer: Save runs the 9A action from this click; Adjust opens the builder on the Website CRM page. */
export function CohortDraftBlockView({block}: {block: CohortDraftBlock}) {
  const router = useRouter();
  return (
    <CohortDraftCard
      draft={block.draft}
      preview={block.preview}
      caveats={block.caveats}
      intro="Ask Coop drafted this cohort. Check the rule and the name, then save. Nothing is saved until you click Save cohort."
      onAdjust={(d) => router.push(adjustHref(d))}
    />
  );
}
