'use client';

// "+ New cohort" / "Edit" on the Website CRM page (RET-10 Stage 9A). A cohort is a group + a name + a rule; customers get the
// label only by matching the rule, live, so there is no member list to pick here. The fields and operators are the closed list in
// src/crm-compute.ts (COHORT_FIELD_SPEC), always shown by their plain labels; the rule is read back as a sentence (ruleText) and
// previewed with the SAME evaluator the page uses (matchesCohort over the page's rows): count + repeat buyer rate vs the 25% target.
// The server action validates everything again (createCohort / updateCohort). 9B's "Adjust the rule" opens this pre-filled.
import {useEffect, useId, useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Plus, Users, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {
  COHORT_FIELDS,
  COHORT_FIELD_SPEC,
  COHORT_OP_LABEL,
  COHORT_RULE_MAX_CONDS,
  REPEAT_TARGET_PCT,
  codeCohorts,
  matchesCohort,
  readCohortRule,
  repeatRate,
  ruleText,
  type CohortField,
  type CohortOp,
  type CustomerRow,
} from '@/src/crm-compute';
import {COHORT_GROUP_MAX, COHORT_NAME_MAX, cohortLabel, labelTaken, readCohortLabel, type CustomerCohort} from '@/src/customer-cohorts';
import {createCohort, updateCohort} from '@/src/customer-cohorts-actions';
import {ModalShell, useModalExit} from './modal-shell';

type DraftCond = {f: CohortField; op: CohortOp; v: string};
/** What the builder opens with: an edit (id), a 9B draft to adjust, or a blank cohort. */
export type CohortDraft = {id?: string; group: string; name: string; conds: DraftCond[]};

const label = 'mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground';
const control = 'h-8 min-w-0 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-primary';

const blankCond = (f: CohortField): DraftCond => {
  const spec = COHORT_FIELD_SPEC[f];
  return {f, op: spec.ops[0], v: spec.type === 'enum' ? Object.keys(spec.values ?? {})[0] : ''};
};
export const blankDraft = (): CohortDraft => ({group: '', name: '', conds: [blankCond('code')]});
export const draftOf = (c: CustomerCohort): CohortDraft => ({id: c.id, group: c.group, name: c.name, conds: c.rule.all.map((k) => ({f: k.f, op: k.op, v: String(k.v)}))});

export function CohortBuilderDialog({
  initial,
  existing,
  rows,
  onClose,
  onSaved,
}: {
  initial: CohortDraft;
  /** Every saved cohort, for the group suggestions and the "already exists" hint (the database decides). */
  existing: CustomerCohort[];
  /** The Customers tab rows: the preview runs the page's own evaluator over them. */
  rows: CustomerRow[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const groupList = useId();
  const codeList = useId();
  const {closing, close} = useModalExit(onClose);
  const [draft, setDraft] = useState<CohortDraft>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const groups = useMemo(() => [...new Set(existing.map((c) => c.group))].sort((a, b) => a.localeCompare(b)), [existing]);
  // First-order codes with buyers, biggest first: suggestions for the code field (the owner maps codes to events, never Coop).
  const codes = useMemo(() => codeCohorts(rows).map((c) => c.group), [rows]);

  const labelRead = readCohortLabel(draft);
  const ruleRead = readCohortRule({all: draft.conds});
  const taken = !('error' in labelRead) && labelTaken(existing, labelRead, draft.id);
  const preview = useMemo(() => {
    if ('error' in ruleRead) return null;
    const members = rows.filter((r) => matchesCohort(r, ruleRead.rule));
    return {count: members.length, rate: repeatRate(members.map((r) => r.orderCount)), sentence: ruleText(ruleRead.rule)};
    // ruleRead is rebuilt every render; the JSON of the draft conditions is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, JSON.stringify(draft.conds)]);

  const setCond = (i: number, next: DraftCond) => setDraft((d) => ({...d, conds: d.conds.map((c, j) => (j === i ? next : c))}));
  const removeCond = (i: number) => setDraft((d) => ({...d, conds: d.conds.length === 1 ? [blankCond('code')] : d.conds.filter((_, j) => j !== i)}));
  const addCond = () => setDraft((d) => ({...d, conds: [...d.conds, blankCond('orders')]}));

  const blocker = 'error' in labelRead ? labelRead.error : 'error' in ruleRead ? ruleRead.error : taken ? `A cohort named ${cohortLabel(labelRead)} already exists.` : null;

  // The label's problem (the rule's shows in the preview box), once the person has typed something.
  const labelHint = (draft.group !== '' || draft.name !== '') && 'error' in labelRead ? labelRead.error : taken ? blocker : null;

  function save() {
    if (blocker || 'error' in labelRead || 'error' in ruleRead) return;
    setError(null);
    const input = {group: labelRead.group, name: labelRead.name, rule: ruleRead.rule};
    startTransition(async () => {
      const res = draft.id ? await updateCohort(draft.id, input) : await createCohort(input);
      if (res.ok) {
        onSaved(res.id);
        router.refresh();
        close();
      } else setError(res.error);
    });
  }

  const rate = preview?.rate;
  const onTarget = rate?.ratePct != null && rate.ratePct >= REPEAT_TARGET_PCT;

  return (
    <ModalShell
      closing={closing}
      onBackdropClick={close}
      labelledBy={titleId}
      panelClassName="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg"
    >
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
            <Users className="size-4" /> {draft.id ? 'Edit cohort' : 'New cohort'}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">A saved rule, not a hand-made list. Customers join and leave it on every refresh.</p>
        </div>
        <button type="button" onClick={close} aria-label="Close" className="text-muted-foreground transition-colors hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <label className="block min-w-0">
            <span className={label}>Group</span>
            <input
              value={draft.group}
              maxLength={COHORT_GROUP_MAX}
              onChange={(e) => setDraft({...draft, group: e.target.value})}
              list={groupList}
              placeholder="e.g. Event"
              autoFocus
              className={cn(control, 'w-full text-sm')}
            />
            <datalist id={groupList}>
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label className="block min-w-0">
            <span className={label}>Name</span>
            <input
              value={draft.name}
              maxLength={COHORT_NAME_MAX}
              onChange={(e) => setDraft({...draft, name: e.target.value})}
              placeholder="e.g. Circuit Makati"
              className={cn(control, 'w-full text-sm')}
            />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            The group puts cohorts of the same kind side by side: every Event, every Promo.
          </p>
        </div>

        <fieldset>
          <legend className={label}>Customers who match all of these</legend>
          <ul className="space-y-2">
            {draft.conds.map((c, i) => {
              const spec = COHORT_FIELD_SPEC[c.f];
              return (
                <li key={i} className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 sm:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto]">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{i === 0 ? 'Where' : 'And'}</span>
                  <select aria-label="Field" value={c.f} onChange={(e) => setCond(i, blankCond(e.target.value as CohortField))} className={control}>
                    {COHORT_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {COHORT_FIELD_SPEC[f].label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeCond(i)}
                    aria-label="Remove this condition"
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] sm:order-last"
                  >
                    <X className="size-3.5" />
                  </button>
                  <select aria-label="Operator" value={c.op} onChange={(e) => setCond(i, {...c, op: e.target.value as CohortOp})} className={cn(control, 'col-start-2 sm:col-start-auto')}>
                    {spec.ops.map((o) => (
                      <option key={o} value={o}>
                        {COHORT_OP_LABEL[o]}
                      </option>
                    ))}
                  </select>
                  {spec.type === 'enum' ? (
                    <select aria-label="Value" value={c.v} onChange={(e) => setCond(i, {...c, v: e.target.value})} className={cn(control, 'col-start-2 sm:col-start-auto')}>
                      {Object.entries(spec.values ?? {}).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label="Value"
                      value={c.v}
                      onChange={(e) => setCond(i, {...c, v: e.target.value})}
                      type={spec.type === 'date' ? 'date' : spec.type === 'num' ? 'number' : 'text'}
                      inputMode={spec.type === 'num' ? (spec.integer ? 'numeric' : 'decimal') : undefined}
                      min={spec.type === 'num' ? 0 : undefined}
                      step={spec.type === 'num' ? (spec.integer ? 1 : 0.01) : undefined}
                      list={spec.type === 'text' ? codeList : undefined}
                      placeholder={spec.type === 'num' ? '0' : spec.type === 'text' ? 'e.g. CIRCUIT10' : undefined}
                      className={cn(control, 'col-start-2 sm:col-start-auto', spec.type === 'text' && 'uppercase')}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <datalist id={codeList}>
            {codes.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          {draft.conds.length < COHORT_RULE_MAX_CONDS && (
            <button type="button" onClick={addCond} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
              <Plus className="size-3.5" /> Add condition
            </button>
          )}
        </fieldset>

        <section aria-live="polite" className="rounded-xl border border-border bg-[var(--card-warm)] px-4 py-3">
          {preview ? (
            <>
              <p className="text-sm text-foreground">{preview.sentence}.</p>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span>
                  <b className="text-lg font-semibold tabular-nums text-foreground">{preview.count.toLocaleString()}</b> customer{preview.count === 1 ? '' : 's'} today
                </span>
                <span>
                  Repeat buyer rate{' '}
                  {rate && rate.ratePct !== null ? (
                    <b className={cn('font-semibold tabular-nums', onTarget ? 'text-[var(--status-good)]' : 'text-foreground')}>
                      {rate.repeat} of {rate.buyers} buyers ({rate.ratePct.toFixed(1)}%)
                    </b>
                  ) : (
                    <b className="font-semibold text-foreground">no buyers yet</b>
                  )}{' '}
                  · target {REPEAT_TARGET_PCT}%
                </span>
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{'error' in ruleRead ? ruleRead.error : ''} The count shows once every condition is filled in.</p>
          )}
        </section>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
        <span className={cn('min-w-0 text-xs', labelHint ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
          {labelHint ?? 'Saved with your account. Only you can edit it.'}
        </span>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={close} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97]">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending || blocker !== null}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] disabled:opacity-50"
          >
            {pending ? 'Saving…' : draft.id ? 'Save changes' : 'Save cohort'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
