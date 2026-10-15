// Contract for the blocks Ask Coop draws in an answer (F7): stat tiles, charts, tables. Types only, no logic.
// Design: knowledge/architecture/2026-10-01-talk-to-data-design.md §§ 4b (recommendView), 4, 7 (slice 2).
// A block carries the DATA the server bound from a stored result: the model only ever names a result id and field
// names, it never types a value (the model-never-types-numbers rule).
import type {ColumnUnit, MetricRow, ResultColumn} from './result-types';

export type ChartForm = 'bar' | 'grouped_bar' | 'stacked_bar' | 'stacked_bar_100' | 'small_multiples' | 'line' | 'area' | 'pie' | 'diverging_bar';
export type Orientation = 'vertical' | 'horizontal';
export type BlockFormat = 'peso' | 'count' | 'percent';

/** What the user (via the model) asked for. 'auto' means code decides. */
export interface ViewRequest {
  kind: 'auto' | ChartForm;
  orientation: 'auto' | Orientation;
}

/** What code actually did, and why. Shown to the model and, in short, to the owner. */
export interface ChosenView {
  form: ChartForm | 'kpi' | 'table';
  orientation: Orientation | null;
  reason: string; // one plain sentence
  /** One line per adjustment made for readability or truth: folded to "Other", substituted a form, etc. */
  adjustments: string[];
  /** 'user' when the form came from an explicit request, 'auto' when code chose it. */
  mode: 'auto' | 'user';
  /** Code-written coverage notes about the data (a group over 10% untagged): added to the block's Notes and returned to the model. */
  notes?: string[];
}

/** A color is a design TOKEN name, never a hex: the UI resolves it per theme. */
export type ColorToken = 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5' | 'cat-1' | 'cat-2' | 'cat-3' | 'cat-4';

export interface Series {
  key: string; // a column key of the source result
  label: string;
  unit: ColumnUnit;
  /** Entity key the color follows (dog, cat, a payment method, "No tag", "Other"): stable, never rank-based. */
  entity: string;
  color: ColorToken;
}

export interface BlockBase {
  /** 'b1', 'b2', ... assigned in order within a conversation turn. */
  id: string;
  /** The result this block was bound from ('r1', ...). */
  source: string;
  title: string;
  /** false when the source result has a failed check: the UI shows a "Not reliable" badge. */
  reliable: boolean;
  /** Plain-language caveats from the source result (coverage, untagged, no pick detail...). */
  caveats: string[];
  /** Short basis line, e.g. "share of tagged bundle revenue, Sep 11 to Sep 27". */
  basis: string | null;
  /** Explore only: true when the block was drawn from a run_query result. The UI shows an "Exploratory" chip. */
  exploratory?: true;
  /** Explore only: the exact SQL that produced the rows, for a collapsed "Show SQL" disclosure. Never sent to the model. */
  sql?: string | null;
}

export interface KpiBlock extends BlockBase {
  kind: 'kpi';
  label: string;
  value: number | null; // null shows an em dash, never 0
  format: BlockFormat;
  sub: string | null; // e.g. "of ₱214,320 total" built by code from the result
}

export interface TableBlock extends BlockBase {
  kind: 'table';
  columns: ResultColumn[];
  rows: MetricRow[]; // exactly the stored rows for the chosen columns, plus nothing else
  total: MetricRow | null; // a total row when the parts add to a whole (computed by code)
}

export interface ChartBlock extends BlockBase {
  kind: 'chart';
  chart: {
    form: ChartForm;
    orientation: Orientation;
    /** The category (or time) field. */
    x: {key: string; label: string; unit: ColumnUnit};
    series: Series[];
    /** The rows to draw, after any fold-to-Other. Values come from the stored result. */
    rows: MetricRow[];
    /** Set when a tail was folded into "Other": how many categories were folded. */
    folded: {count: number; into: string} | null;
  };
  chosen: ChosenView;
  /** The table twin: the SAME rows with every category (nothing dropped by a fold), so no value lives only in a chart. */
  twin: {columns: ResultColumn[]; rows: MetricRow[]};
}

export type ChatBlock = KpiBlock | ChartBlock | TableBlock;
