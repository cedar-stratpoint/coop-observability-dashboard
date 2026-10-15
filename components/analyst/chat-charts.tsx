'use client';

// Recharts renderers for the chart blocks of an Ask Coop answer (F7). Loaded as an async chunk by ./chat-blocks
// (next/dynamic, ssr:false), exactly like ./charts-lazy, so Recharts stays out of the drawer's initial JS.
// Rules (dataviz reference + design 4b): colors only from series[].color tokens (never a hex), "No tag" / "Other" use the
// neutral token, thin bars with 2px gaps and 4px rounded data ends square at the baseline, one hairline solid grid,
// tabular numerals on axes, a legend for 2+ series, a tooltip, and a table twin (in ./chat-blocks) so no value is chart-only.
import {Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, Tooltip, XAxis, YAxis} from 'recharts';
import type {ChartBlock, ColorToken, Series} from '@/src/chat/block-types';
import type {MetricRow} from '@/src/chat/result-types';
import {ChartContainer, type ChartConfig} from '@/components/ui/chart';
import {cn} from '@/lib/utils';
import {NEUTRAL_TOKEN, ariaSummary, resolveForm, formatAxis, formatCategory, formatValue, pieSlices, shortLabel, tokenToCssVar, type PieSlice} from './chat-blocks-format';

const GRID = 'var(--border)'; // hairline, one shade off the card surface; solid, never dashed
const SURFACE = 'var(--card)'; // the 2px gap between stacked fills is a surface-colored stroke
const DOWN_TOKEN: ColorToken = NEUTRAL_TOKEN; // diverging: down is the warm neutral (never a status color)
const SLICE_ORDER: ColorToken[] = ['chart-1', 'cat-2', 'chart-3', 'chart-4', 'cat-3', 'cat-4'];
const MAX_SLICES = 6;
const BAR_THICKNESS = 14; // thin marks
const FEW_POINTS = 8; // markers (8px) only up to this many points

const cat = (row: MetricRow, key: string): string | number | null => row[key] ?? null;

function Legend({items}: {items: {label: string; token: ColorToken; value?: string}[]}) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="Legend">
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <span className="size-2 shrink-0 rounded-[3px]" style={{backgroundColor: tokenToCssVar(it.token)}} aria-hidden />
          <span>{shortLabel(it.label, 28)}</span>
          {it.value && <span className="font-medium tabular-nums text-foreground">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}

type TipProps = {active?: boolean; payload?: ReadonlyArray<{payload?: unknown}>; block: ChartBlock};

function Tip({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      <ul className="flex min-w-[9rem] flex-col gap-0.5">{children}</ul>
    </div>
  );
}

function TipRow({token, label, value, bold}: {token?: ColorToken; label: string; value: string; bold?: boolean}) {
  return (
    <li className="flex items-center gap-1.5">
      {token ? <span className="size-2 shrink-0 rounded-[3px]" style={{backgroundColor: tokenToCssVar(token)}} aria-hidden /> : <span className="size-2 shrink-0" aria-hidden />}
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('ml-auto pl-3 tabular-nums text-foreground', bold ? 'font-semibold' : 'font-medium')}>{value}</span>
    </li>
  );
}

/** Category plus every series value, formatted with the series unit. Stacked forms add a total, 100% adds each share. */
function RowTooltip({active, payload, block}: TipProps) {
  const row = payload?.[0]?.payload as MetricRow | undefined;
  if (!active || !row) return null;
  const {chart} = block;
  const stacked = chart.form === 'stacked_bar' || chart.form === 'stacked_bar_100';
  const nums = chart.series.map((s) => (typeof row[s.key] === 'number' ? (row[s.key] as number) : 0));
  const total = nums.reduce((a, b) => a + b, 0);
  return (
    <Tip title={formatCategory(cat(row, chart.x.key), chart.x.unit)}>
      {chart.series.map((s) => {
        const v = row[s.key];
        const share = chart.form === 'stacked_bar_100' && total > 0 && typeof v === 'number' ? ` (${formatValue((v / total) * 100, 'percent')})` : '';
        return <TipRow key={s.key} token={s.color} label={s.label} value={`${formatValue(v, s.unit)}${share}`} />;
      })}
      {stacked && chart.series.length > 1 && <TipRow label="Total" value={formatValue(total, chart.series[0].unit)} bold />}
    </Tip>
  );
}

type Slice = PieSlice;

function PieTooltip({active, payload}: {active?: boolean; payload?: ReadonlyArray<{payload?: unknown}>}) {
  const s = payload?.[0]?.payload as Slice | undefined;
  if (!active || !s) return null;
  return (
    <Tip title={s.name}>
      <TipRow token={s.token} label="Value" value={formatValue(s.value, s.unit)} />
    </Tip>
  );
}

function labelWidth(labels: string[], max: number): number {
  const longest = Math.min(max, Math.max(...labels.map((l) => l.length), 4));
  return Math.round(longest * 6.2 + 10);
}

function PiePlot({block, aria}: {block: ChartBlock; aria: string}) {
  const {chart} = block;
  const slices: Slice[] = pieSlices(chart, MAX_SLICES);
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <>
      <ChartContainer config={{}} role="img" aria-label={aria} className="mx-auto aspect-auto h-[180px] w-full">
        <PieChart>
          {/* A real pie when a pie is asked (the owner asked for a pie, not a donut). */}
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius={0} outerRadius="92%" paddingAngle={2} cornerRadius={4} stroke="none" startAngle={90} endAngle={-270} isAnimationActive={false}>
            {slices.map((s) => (
              <Cell key={s.name} fill={tokenToCssVar(s.token)} />
            ))}
          </Pie>
          <Tooltip content={<PieTooltip />} />
        </PieChart>
      </ChartContainer>
      <Legend items={slices.map((s) => ({label: s.name, token: s.token, value: `${formatValue(s.value, s.unit)} · ${formatValue((s.value / total) * 100, 'percent')}`}))} />
    </>
  );
}

function BarPlot({block, aria, max, bare = false}: {block: ChartBlock; aria: string; max?: number; bare?: boolean}) {
  const {chart} = block;
  const {form, rows, series, x} = chart;
  const horizontal = chart.orientation === 'horizontal';
  const stacked = form === 'stacked_bar' || form === 'stacked_bar_100';
  const grouped = form === 'grouped_bar';
  const diverging = form === 'diverging_bar';
  const pct = form === 'stacked_bar_100';
  const unit = series[0].unit;
  const n = rows.length;
  const labels = rows.map((r) => formatCategory(cat(r, x.key), x.unit));
  const valueTick = (v: number) => (pct ? `${Math.round(v * 100)}%` : formatAxis(v, unit));
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, {label: s.label, color: tokenToCssVar(s.color)}]));
  const radius: [number, number, number, number] = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  const flat: [number, number, number, number] = [0, 0, 0, 0];
  const size = grouped ? 10 : BAR_THICKNESS;

  // Vertical bars with many categories get a minimum width and scroll sideways inside their own container.
  const perCat = grouped ? series.length * (size + 2) + 26 : 52;
  const scrolls = !horizontal && n > 6;
  const minWidth = scrolls ? n * perCat : undefined;
  // Horizontal bars: height holds the bars plus the value-axis band, so the chart never scrolls vertically.
  const perRow = grouped ? series.length * (size + 2) + 16 : BAR_THICKNESS + 16;
  const height = horizontal ? Math.max(bare ? 64 : 130, n * perRow + 40) : 240;
  const catWidth = labelWidth(labels, 18);

  const bars = diverging ? (
    <Bar dataKey={(r: MetricRow) => r[series[0].key]} name={series[0].label} radius={radius} barSize={size} isAnimationActive={false}>
      {rows.map((r, i) => {
        const v = r[series[0].key];
        return <Cell key={i} fill={tokenToCssVar(typeof v === 'number' && v < 0 ? DOWN_TOKEN : series[0].color)} />;
      })}
    </Bar>
  ) : (
    series.map((s, i) => (
      <Bar
        key={s.key}
        dataKey={(r: MetricRow) => r[s.key]}
        name={s.label}
        fill={tokenToCssVar(s.color)}
        stackId={stacked ? 'a' : undefined}
        stroke={stacked ? SURFACE : undefined}
        strokeWidth={stacked ? 2 : 0}
        radius={stacked ? (i === series.length - 1 ? radius : flat) : radius}
        barSize={size}
        isAnimationActive={false}
      />
    ))
  );

  const tick = {fontSize: 11};
  const tipCursor = {fill: 'var(--muted)', opacity: 0.4};
  const chartEl = (
    <ChartContainer
      config={config}
      role="img"
      aria-label={aria}
      className="aspect-auto w-full justify-start [&_.recharts-cartesian-axis-tick_text]:tabular-nums"
      style={{height, minWidth}}
    >
      <BarChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'} stackOffset={pct ? 'expand' : 'none'} barGap={2} barCategoryGap={horizontal ? '28%' : '24%'} margin={{top: 8, right: horizontal ? 16 : 8, bottom: 0, left: 0}}>
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke={GRID} strokeDasharray="0" />
        {horizontal ? (
          <>
            <XAxis type="number" tickLine={false} axisLine={false} tick={tick} tickMargin={6} tickCount={4} tickFormatter={valueTick} domain={pct ? [0, 1] : max !== undefined ? [0, max] : undefined} />
            <YAxis type="category" hide={bare} dataKey={(r: MetricRow) => cat(r, x.key)} width={bare ? 0 : catWidth} tickLine={false} axisLine={{stroke: GRID}} tick={tick} interval={0} tickFormatter={(v) => shortLabel(formatCategory(v, x.unit), 18)} />
          </>
        ) : (
          <>
            <XAxis dataKey={(r: MetricRow) => cat(r, x.key)} tickLine={false} axisLine={{stroke: GRID}} tick={tick} tickMargin={8} interval={scrolls ? 0 : 'preserveStartEnd'} minTickGap={10} tickFormatter={(v) => shortLabel(formatCategory(v, x.unit), scrolls ? 10 : 12)} />
            <YAxis width="auto" tickLine={false} axisLine={false} tick={tick} tickMargin={4} tickCount={5} tickFormatter={valueTick} domain={pct ? [0, 1] : max !== undefined ? [0, max] : undefined} />
          </>
        )}
        {diverging && (horizontal ? <ReferenceLine x={0} stroke={GRID} /> : <ReferenceLine y={0} stroke={GRID} />)}
        <Tooltip cursor={tipCursor} content={<RowTooltip block={block} />} />
        {bars}
      </BarChart>
    </ChartContainer>
  );

  const legend = bare ? null : diverging ? (
    <Legend items={[{label: 'Increase', token: series[0].color}, {label: 'Decrease', token: DOWN_TOKEN}]} />
  ) : series.length >= 2 ? (
    <Legend items={series.map((s) => ({label: s.label, token: s.color}))} />
  ) : null;

  return (
    <>
      {scrolls ? (
        <div tabIndex={0} aria-label="Chart, scrolls sideways" className="overflow-x-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {chartEl}
        </div>
      ) : (
        chartEl
      )}
      {legend}
    </>
  );
}

function LinePlot({block, aria}: {block: ChartBlock; aria: string}) {
  const {chart} = block;
  const {rows, series, x} = chart;
  const unit = series[0].unit;
  const few = rows.length <= FEW_POINTS;
  const area = chart.form === 'area';
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, {label: s.label, color: tokenToCssVar(s.color)}]));
  const common = (
    <>
      <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="0" />
      <XAxis dataKey={(r: MetricRow) => cat(r, x.key)} tickLine={false} axisLine={{stroke: GRID}} tick={{fontSize: 11}} tickMargin={8} interval="preserveStartEnd" minTickGap={16} tickFormatter={(v) => shortLabel(formatCategory(v, x.unit), 12)} />
      <YAxis width="auto" tickLine={false} axisLine={false} tick={{fontSize: 11}} tickMargin={4} tickCount={5} tickFormatter={(v: number) => formatAxis(v, unit)} />
      <Tooltip cursor={{stroke: GRID}} content={<RowTooltip block={block} />} />
    </>
  );
  const margin = {top: 8, right: 12, bottom: 0, left: 0};
  return (
    <>
      <ChartContainer config={config} role="img" aria-label={aria} className="aspect-auto h-[240px] w-full justify-start [&_.recharts-cartesian-axis-tick_text]:tabular-nums">
        {area ? (
          <AreaChart data={rows} margin={margin}>
            {common}
            <Area
              type="linear"
              dataKey={(r: MetricRow) => r[series[0].key]}
              name={series[0].label}
              stroke={tokenToCssVar(series[0].color)}
              strokeWidth={2}
              fill={tokenToCssVar(series[0].color)}
              fillOpacity={0.15}
              dot={few ? {r: 4, fill: tokenToCssVar(series[0].color), stroke: SURFACE, strokeWidth: 1} : false}
              activeDot={{r: 5}}
              isAnimationActive={false}
            />
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={margin}>
            {common}
            {series.map((s) => (
              <Line
                key={s.key}
                type="linear"
                dataKey={(r: MetricRow) => r[s.key]}
                name={s.label}
                stroke={tokenToCssVar(s.color)}
                strokeWidth={2}
                dot={few ? {r: 4, fill: tokenToCssVar(s.color), stroke: SURFACE, strokeWidth: 1} : false}
                activeDot={{r: 5}}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ChartContainer>
      {series.length >= 2 && <Legend items={series.map((s) => ({label: s.label, token: s.color}))} />}
    </>
  );
}

/** Small multiples (2c.1): one small horizontal bar chart per group, every panel on the same value scale, one legend for all. */
function SmallMultiplesPlot({block}: {block: ChartBlock}) {
  const {chart} = block;
  const values = chart.rows.flatMap((r) => chart.series.map((s) => r[s.key])).filter((v): v is number => typeof v === 'number');
  const max = Math.max(0, ...values);
  return (
    <>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        {chart.rows.map((r, i) => {
          const name = formatCategory(cat(r, chart.x.key), chart.x.unit);
          const panel: ChartBlock = {...block, chart: {...chart, form: 'grouped_bar', orientation: 'horizontal', rows: [r], folded: null}};
          return (
            <figure key={`${i}-${name}`} className="m-0 flex min-w-0 flex-col gap-1">
              <figcaption className="truncate text-[12px] font-medium text-foreground" title={name}>
                {name}
              </figcaption>
              <BarPlot block={panel} aria={`${block.title}: ${name}`} max={max} bare />
            </figure>
          );
        })}
      </div>
      {chart.series.length >= 2 && <Legend items={chart.series.map((s) => ({label: s.label, token: s.color}))} />}
    </>
  );
}

/** Draws one ChartBlock. A single series needs no legend (the title names it); 2+ series always get one. */
export function ChartView({block}: {block: ChartBlock}) {
  const {chart} = block;
  if (chart.series.length === 0 || chart.rows.length === 0) {
    return <p className="text-[12px] text-muted-foreground">Nothing to draw. See the table.</p>;
  }
  const aria = ariaSummary(block);
  // A form this renderer cannot draw falls back to grouped bars (resolveForm), never blank or a crash.
  const form = resolveForm(chart.form);
  const drawn: ChartBlock = form === chart.form ? block : {...block, chart: {...chart, form}};
  return (
    <div className="flex flex-col gap-2">
      {form === 'pie' ? <PiePlot block={drawn} aria={aria} /> : form === 'small_multiples' ? <SmallMultiplesPlot block={drawn} /> : form === 'line' || form === 'area' ? <LinePlot block={drawn} aria={aria} /> : <BarPlot block={drawn} aria={aria} />}
    </div>
  );
}
