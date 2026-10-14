'use client';

// Recharts lives here, split out of offline-sales.tsx so it loads as an async
// chunk (see the next/dynamic wrapper there) instead of riding in the route's
// initial JS. Only the payment-method stacked bar chart + its tooltip.
import {Bar, BarChart, CartesianGrid, XAxis, YAxis} from 'recharts';
import type {DayMethodRevenue} from '@/src/pos-sales-types';
import {formatPeso, paymentMethodColor, paymentMethodLabel} from '@/src/pos-format';
import {ChartContainer, ChartTooltip, type ChartConfig} from '@/components/ui/chart';
import {cn} from '@/lib/utils';

const shortDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric'});

// Per-day revenue stacked by payment method. When a method is selected its
// segments keep full color and the rest go grey (still visible). Hovering a bar
// shows each payment option's amount for that day.
export function MethodStackChart({
  data,
  methods,
  selected,
  className = 'h-[220px]',
}: {
  data: DayMethodRevenue[];
  methods: string[];
  selected: string;
  className?: string; // chart height; the overview grows it on wide screens
}) {
  const config = Object.fromEntries(methods.map((m) => [m, {label: paymentMethodLabel(m), color: paymentMethodColor(m)}])) as ChartConfig;
  const rows = data.map((d) => ({label: shortDay(d.day), ...Object.fromEntries(methods.map((m) => [m, d.byMethod[m] ?? 0]))}));
  const topMethod = methods[methods.length - 1];

  return (
    <div className="flex flex-col gap-2">
      <ChartContainer config={config} className={cn(className, 'w-full')}>
        <BarChart data={rows} margin={{left: 4, right: 8, top: 8, bottom: 0}}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
          <YAxis tickLine={false} axisLine={false} width={44} fontSize={11} tickFormatter={(v) => formatPeso(Number(v))} />
          <ChartTooltip cursor={{fill: 'var(--muted)', opacity: 0.35}} content={<MethodTooltip />} />
          {methods.map((m) => {
            const active = selected === 'all' || selected === m;
            return (
              <Bar
                key={m}
                dataKey={m}
                stackId="rev"
                fill={active ? paymentMethodColor(m) : '#52525b'}
                fillOpacity={active ? 1 : 0.35}
                radius={m === topMethod ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                isAnimationActive={false}
              />
            );
          })}
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {methods.map((m) => {
          const active = selected === 'all' || selected === m;
          return (
            <span key={m} className={cn('inline-flex items-center gap-1.5 text-[11px]', active ? 'text-muted-foreground' : 'text-muted-foreground/40')}>
              <span className="size-2 rounded-[3px]" style={{backgroundColor: active ? paymentMethodColor(m) : '#52525b'}} />
              {paymentMethodLabel(m)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

type TooltipRow = {dataKey?: string; value?: number};

/** Mini tooltip: each payment option's revenue for the hovered day. */
function MethodTooltip({active, payload, label}: {active?: boolean; payload?: TooltipRow[]; label?: string}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => Number(p.value) > 0);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-lg">
      <div className="mb-1 font-medium text-foreground">{label}</div>
      <ul className="flex min-w-[9rem] flex-col gap-0.5">
        {rows.map((p) => (
          <li key={p.dataKey} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[3px]" style={{backgroundColor: paymentMethodColor(p.dataKey)}} />
            <span className="text-muted-foreground">{paymentMethodLabel(p.dataKey)}</span>
            <span className="ml-auto font-medium tabular-nums text-foreground">{formatPeso(Number(p.value))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
