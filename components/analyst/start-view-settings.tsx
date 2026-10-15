'use client';

import {useState, useTransition} from 'react';
import {Check, History, Loader2} from 'lucide-react';
import {setDefaultViewAction} from '@/app/actions/company';
import {groupViews, type SwitcherView} from '@/src/view-switcher';
import {ViewBadge} from '@/components/analyst/company-switcher';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';

// Settings → Starting view (multi-role users only). Picks where you land at each
// sign-in: "Where I left off" (the default — your most recent view), or a pinned
// view. Saves on change; the server re-validates the choice against your roles.
// Same badges and order as the header switcher (Coop Admin, then companies A–Z).

const ROLE_LABEL: Record<string, string> = {
  coop_admin: 'Coop Admin',
  company_admin: 'Company User',
  analyst: 'Analyst',
  store_manager: 'Store Manager',
};

const LAST = '';

// Module-level (not defined during render) so the radios keep their identity — and
// keyboard focus / arrow-key navigation — across re-renders.
function Option({
  id,
  value,
  disabled,
  onChoose,
  label,
  caption,
  badge,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChoose: (id: string) => void;
  label: string;
  caption: string;
  badge: React.ReactNode;
}) {
  const on = value === id;
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40',
        on ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-foreground/25',
        disabled && !on && 'cursor-wait opacity-60',
      )}
    >
      <input
        type="radio"
        name="start-view"
        value={id}
        checked={on}
        disabled={disabled && !on}
        onChange={() => onChoose(id)}
        className="sr-only"
      />
      {badge}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{caption}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border',
          on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
        )}
      >
        {on && <Check className="size-3" strokeWidth={3} />}
      </span>
    </label>
  );
}

export function StartViewSettings({
  views,
  defaultView,
  lastView,
}: {
  views: SwitcherView[];
  defaultView: string | null;
  lastView: string | null;
}) {
  const held = (k: string | null) => Boolean(k) && views.some((v) => v.key === k);
  const [value, setValue] = useState<string>(held(defaultView) ? (defaultView as string) : LAST);
  const [status, setStatus] = useState<{kind: 'saving' | 'saved' | 'err'; text: string} | null>(null);
  const [saving, startTransition] = useTransition();
  const {coop, companies} = groupViews(views);
  const lastName = held(lastView) ? views.find((v) => v.key === lastView)?.name : null;
  const title = (v: SwitcherView) => (v.companyId ? v.name : 'Coop Admin');

  function choose(next: string) {
    if (next === value || saving) return; // one save at a time — no out-of-order reverts
    const prev = value;
    setValue(next);
    setStatus({kind: 'saving', text: 'Saving…'});
    startTransition(async () => {
      const res = await setDefaultViewAction(next === LAST ? null : next);
      if (res.ok) setStatus({kind: 'saved', text: 'Saved. This applies the next time you sign in.'});
      else {
        setValue(prev);
        setStatus({kind: 'err', text: res.error});
      }
    });
  }

  return (
    <Card>
      <CardContent>
        <fieldset className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <legend className="font-heading text-base font-semibold">Starting view</legend>
            <p className="text-sm text-muted-foreground">
              Where you land each time you sign in. You can still switch any time from the menu at the top.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Option
              id={LAST}
              value={value}
              disabled={saving}
              onChoose={choose}
              label="Where I left off"
              caption={lastName ? `The last view you used — right now that’s ${lastName}` : 'The last view you used'}
              badge={
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <History className="size-3.5" />
                </span>
              }
            />
            <div className="my-1 flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden />
              or always start in
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>
            {coop && (
              <Option id={coop.key} value={value} disabled={saving} onChoose={choose} label="Coop Admin" caption="People & roles · no business data" badge={<ViewBadge view={coop} />} />
            )}
            {companies.map((v) => (
              <Option key={v.key} id={v.key} value={value} disabled={saving} onChoose={choose} label={title(v)} caption={ROLE_LABEL[v.role] ?? v.role} badge={<ViewBadge view={v} />} />
            ))}
          </div>

          <p
            aria-live="polite"
            className={cn(
              'flex min-h-5 items-center gap-1.5 text-xs',
              status?.kind === 'err' ? 'text-destructive' : 'text-muted-foreground',
            )}
            style={status?.kind === 'saved' ? {color: 'var(--status-good)'} : undefined}
          >
            {status?.kind === 'saving' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {status?.kind === 'saved' && <Check className="size-3.5" aria-hidden />}
            {status?.text}
          </p>
        </fieldset>
      </CardContent>
    </Card>
  );
}
