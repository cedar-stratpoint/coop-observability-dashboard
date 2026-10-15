// SYNTHETIC fixtures for the dev preview page (app/dev/chat-blocks). Every figure is invented: none comes from production.
import type {BlockBase, ChartBlock, ChartForm, ChatBlock, ChosenView, ColorToken, Orientation, Series, TableBlock} from '@/src/chat/block-types';
import type {ColumnUnit, MetricRow, ResultColumn} from '@/src/chat/result-types';

const base = (id: string, title: string, over: Partial<BlockBase> = {}): BlockBase => ({id, source: 'r1', title, reliable: true, caveats: [], basis: null, ...over});
const col = (key: string, label: string, unit: ColumnUnit, role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});
const ser = (key: string, label: string, color: ColorToken, unit: ColumnUnit = 'PHP', entity = label): Series => ({key, label, unit, entity, color});
const chosen = (form: ChartForm, orientation: Orientation, reason: string, adjustments: string[] = []): ChosenView => ({form, orientation, reason, adjustments, mode: 'auto'});

interface ChartSpec {
  id: string;
  title: string;
  form: ChartForm;
  orientation: Orientation;
  xKey: string;
  xLabel: string;
  xUnit?: ColumnUnit;
  series: Series[];
  rows: MetricRow[];
  twinRows?: MetricRow[];
  folded?: {count: number; into: string} | null;
  adjustments?: string[];
  over?: Partial<BlockBase>;
}

function chart(s: ChartSpec): ChartBlock {
  const xUnit = s.xUnit ?? 'text';
  const cols = [col(s.xKey, s.xLabel, xUnit, xUnit === 'date' ? 'time' : 'category'), ...s.series.map((x) => col(x.key, x.label, x.unit, 'measure'))];
  return {
    ...base(s.id, s.title, s.over),
    kind: 'chart',
    chart: {form: s.form, orientation: s.orientation, x: {key: s.xKey, label: s.xLabel, unit: xUnit}, series: s.series, rows: s.rows, folded: s.folded ?? null},
    chosen: chosen(s.form, s.orientation, 'Synthetic fixture.', s.adjustments),
    twin: {columns: cols, rows: s.twinRows ?? s.rows},
  };
}

export const kpiRow: ChatBlock[] = [
  {...base('f-k1', 'Bundle revenue', {basis: 'Sample window'}), kind: 'kpi', label: 'Bundle revenue', value: 128400, format: 'peso', sub: 'of ₱190,000 total'},
  {...base('f-k2', 'Bundle share'), kind: 'kpi', label: 'Bundle share of all revenue', value: 67.6, format: 'percent', sub: null},
  {...base('f-k3', 'Bundle orders'), kind: 'kpi', label: 'Bundle orders', value: 1234, format: 'count', sub: 'Sample window'},
  {...base('f-k4', 'Missing value'), kind: 'kpi', label: 'Dog share of tagged', value: null, format: 'percent', sub: 'Not enough tagged orders'},
];

const bundleRows: MetricRow[] = [
  {bundle: 'Bundle Alpha', dog: 52000, cat: 14000, both: 12500, untagged: 0},
  {bundle: 'Bundle Beta', dog: 6200, cat: 0, both: 450, untagged: 0},
  {bundle: 'Bundle Gamma', dog: 2100, cat: 900, both: 0, untagged: 0},
  {bundle: 'No tag', dog: 0, cat: 0, both: 0, untagged: 33000},
];
const petSeries = [ser('dog', 'Dog', 'chart-1'), ser('cat', 'Cat', 'cat-2'), ser('both', 'Both', 'chart-4'), ser('untagged', 'No tag', 'chart-5')];

export const stackedHorizontal = chart({
  id: 'f-c1',
  title: 'Bundle revenue by pet',
  form: 'stacked_bar',
  orientation: 'horizontal',
  xKey: 'bundle',
  xLabel: 'Bundle',
  series: petSeries,
  rows: bundleRows,
  over: {basis: 'revenue in pesos, sample window'},
});

const skuNames = ['Chicken Slices', 'Duck Strips', 'Beef Liver Bites', 'Salmon Cubes', 'Yoghurt Cubes', 'Cat Grass Cubes', 'Turkey Rings', 'Lamb Jerky', 'Sweet Potato Chews', 'Fish Skin Twists', 'Pumpkin Biscuits', 'Cheese Puffs', 'Apple Crunch', 'Egg Rolls', 'Liver Pate', 'Oat Cookies'];
const skuAll: MetricRow[] = skuNames.map((name, i) => {
  const t = 11800 - i * 640;
  return {sku: name, dog: Math.round(t * 0.55), cat: Math.round(t * 0.3), both: Math.round(t * 0.15)};
});

export const groupedVertical = chart({
  id: 'f-c2',
  title: 'Top SKUs by pet',
  form: 'grouped_bar',
  orientation: 'vertical',
  xKey: 'sku',
  xLabel: 'SKU',
  series: [ser('dog', 'Dog', 'chart-1'), ser('cat', 'Cat', 'cat-2'), ser('both', 'Both', 'chart-4')],
  rows: skuAll.slice(0, 7),
  twinRows: skuAll,
  adjustments: ['Showing the top 7 of 16 SKUs; all 16 are in the table.'],
  over: {basis: 'allocated revenue in pesos'},
});

export const plainBar = chart({
  id: 'f-c3',
  title: 'Revenue by payment method',
  form: 'bar',
  orientation: 'horizontal',
  xKey: 'method',
  xLabel: 'Payment method',
  series: [ser('revenue', 'Revenue', 'chart-1')],
  rows: [
    {method: 'Cash', revenue: 42300},
    {method: 'GCash', revenue: 31800},
    {method: 'Card', revenue: 15200},
    {method: 'Bank transfer', revenue: 6100},
    {method: 'Other', revenue: 2400},
  ],
});

export const donut4 = chart({
  id: 'f-c4',
  title: 'Orders by channel',
  form: 'pie',
  orientation: 'vertical',
  xKey: 'part',
  xLabel: 'Orders',
  series: [ser('Offline', 'Offline', 'cat-1', 'count'), ser('Website', 'Website', 'cat-2', 'count'), ser('Shopee', 'Shopee', 'cat-3', 'count'), ser('Lazada', 'Lazada', 'cat-4', 'count')],
  rows: [{part: 'Orders', Offline: 640, Website: 410, Shopee: 290, Lazada: 120}],
  twinRows: [
    {part: 'Offline', Offline: 640},
    {part: 'Website', Website: 410},
    {part: 'Shopee', Shopee: 290},
    {part: 'Lazada', Lazada: 120},
  ],
});

const eventRows: MetricRow[] = ['Market Day', 'Pet Expo', 'Mall Pop-up', 'Fun Run', 'Fair Booth', 'Night Bazaar', 'School Fair', 'Park Meetup', 'Brand Day', 'Holiday Fair', 'Weekend Fair', 'Pop-up Two'].map((event, i) => ({event, revenue: 9800 - i * 700}));
const foldedTail = eventRows.slice(5).reduce((a, r) => a + (r.revenue as number), 0);

export const donutFolded = chart({
  id: 'f-c5',
  title: 'Revenue by event',
  form: 'pie',
  orientation: 'vertical',
  xKey: 'part',
  xLabel: 'Revenue',
  series: [...eventRows.slice(0, 5).map((r, i) => ser(String(r.event), String(r.event), (['cat-1', 'cat-2', 'cat-3', 'cat-4', 'chart-1'] as ColorToken[])[i])), ser('other', 'Other', 'chart-5')],
  rows: [{part: 'Revenue', ...Object.fromEntries(eventRows.slice(0, 5).map((r) => [String(r.event), r.revenue])), other: foldedTail}],
  twinRows: eventRows,
  folded: {count: 7, into: 'Other'},
  adjustments: ['Showing the top 5 and Other; all 12 are in the table.'],
});

const days = Array.from({length: 10}, (_, i) => `2026-09-${String(11 + i).padStart(2, '0')}`);
export const lineThree = chart({
  id: 'f-c6',
  title: 'Daily revenue by channel',
  form: 'line',
  orientation: 'vertical',
  xKey: 'day',
  xLabel: 'Day',
  xUnit: 'date',
  series: [ser('offline', 'Offline', 'chart-1'), ser('web', 'Website', 'cat-2'), ser('shopee', 'Shopee', 'chart-4')],
  rows: days.map((day, i) => ({day, offline: 4200 + ((i * 937) % 2600), web: 2100 + ((i * 611) % 1800), shopee: 1500 + ((i * 433) % 1400)})),
});

const days14 = Array.from({length: 14}, (_, i) => `2026-09-${String(1 + i).padStart(2, '0')}`);
export const areaOne = chart({
  id: 'f-c7',
  title: 'Daily orders',
  form: 'area',
  orientation: 'vertical',
  xKey: 'day',
  xLabel: 'Day',
  xUnit: 'date',
  series: [ser('orders', 'Orders', 'chart-1', 'count')],
  rows: days14.map((day, i) => ({day, orders: 18 + ((i * 7) % 15) + (i > 9 ? 6 : 0)})),
});

export const diverging = chart({
  id: 'f-c8',
  title: 'Revenue change vs previous period',
  form: 'diverging_bar',
  orientation: 'horizontal',
  xKey: 'channel',
  xLabel: 'Channel',
  series: [ser('delta', 'Change', 'chart-1')],
  rows: [
    {channel: 'Offline', delta: 8400},
    {channel: 'Website', delta: 3100},
    {channel: 'Shopee', delta: -2700},
    {channel: 'Lazada', delta: -6200},
  ],
  over: {basis: 'change in pesos vs the previous 14 days'},
});

const tableColumns = [col('method', 'Payment method', 'text', 'category'), col('orders', 'Orders', 'count', 'measure'), col('revenue', 'Revenue', 'PHP', 'measure'), col('share', 'Share', 'percent', 'share')];
export const tableTotal: TableBlock = {
  ...base('f-t1', 'Payments breakdown', {basis: 'sample window'}),
  kind: 'table',
  columns: tableColumns,
  rows: [
    {method: 'Cash', orders: 310, revenue: 42300.5, share: 45.2},
    {method: 'GCash', orders: 240, revenue: 31800, share: 34},
    {method: 'Card', orders: 110, revenue: 15200.25, share: 16.2},
    {method: 'Bank transfer', orders: 40, revenue: 4300, share: 4.6},
  ],
  total: {method: null, orders: 700, revenue: 93600.75, share: 100},
};

export const unreliable = chart({
  id: 'f-c9',
  title: 'Revenue by pet (sample data)',
  form: 'stacked_bar',
  orientation: 'horizontal',
  xKey: 'bundle',
  xLabel: 'Bundle',
  series: petSeries.slice(0, 3),
  rows: bundleRows.slice(0, 3),
  over: {reliable: false, caveats: ['This is sample data, not store figures.']},
});

export const withCaveats = chart({
  id: 'f-c10',
  title: 'Orders by event',
  form: 'bar',
  orientation: 'horizontal',
  xKey: 'event',
  xLabel: 'Event',
  series: [ser('orders', 'Orders', 'chart-1', 'count')],
  rows: [
    {event: 'Market Day', orders: 88},
    {event: 'Pet Expo', orders: 64},
    {event: 'A very long event name that must truncate with an ellipsis', orders: 41},
  ],
  over: {
    basis: 'orders, sample window',
    caveats: ['Only 3 events fall in the window, so shares are not comparable.', 'Orders without an event are left out of this chart.'],
  },
});

export const stacked100 = chart({
  id: 'f-c11',
  title: 'Pet mix by bundle (100%)',
  form: 'stacked_bar_100',
  orientation: 'horizontal',
  xKey: 'bundle',
  xLabel: 'Bundle',
  series: petSeries.slice(0, 3),
  rows: bundleRows.slice(0, 3),
});

export const smallMultiples = chart({
  id: 'f-c12',
  title: 'Revenue by event and pet',
  form: 'small_multiples',
  orientation: 'horizontal',
  xKey: 'event',
  xLabel: 'Event',
  series: [ser('untagged', 'untagged', 'chart-5'), ser('dog', 'dog', 'cat-1'), ser('cat', 'cat', 'cat-2'), ser('both', 'both', 'cat-3')],
  rows: [
    {event: 'Pop-up Market', untagged: 3000, dog: null, cat: null, both: null},
    {event: 'Pet Fair North', untagged: 370, dog: 960, cat: 1124, both: 450},
    {event: 'Weekend Expo', untagged: 150, dog: 1275, cat: 600, both: 499},
  ],
  over: {caveats: ['Pop-up Market: 100% of revenue has no pet tag.']},
});

export const previewGroups: {label: string; blocks: ChatBlock[]}[] = [
  {label: 'KPI row (4 tiles)', blocks: kpiRow},
  {label: 'Horizontal stacked bar with a separate No tag bar', blocks: [stackedHorizontal]},
  {label: 'Vertical grouped bar, top 7 of 16 SKUs (twin has 16)', blocks: [groupedVertical]},
  {label: 'Plain descending bar', blocks: [plainBar]},
  {label: 'Pie, 4 slices', blocks: [donut4]},
  {label: 'Pie folded to 5 + Other', blocks: [donutFolded]},
  {label: 'Line, 3 series', blocks: [lineThree]},
  {label: 'Area, 1 series', blocks: [areaOne]},
  {label: 'Diverging bar', blocks: [diverging]},
  {label: '100% stacked bar', blocks: [stacked100]},
  {label: 'Small multiples, one panel per event (shared scale)', blocks: [smallMultiples]},
  {label: 'Table with a total row', blocks: [tableTotal]},
  {label: 'Not reliable', blocks: [unreliable]},
  {label: 'With caveats and a long label', blocks: [withCaveats]},
];
