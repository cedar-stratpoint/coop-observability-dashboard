// Weekly and monthly buckets for the Sales range view's "Over time" chart. Pure, no I/O.
// The buckets come from period-rollup (the same code as the totals), so the bars add up to the page's numbers. A bucket the dates
// cut short ("clipped") is flagged so the chart can show it as partial; each channel keeps its own status for the same reason.
import {addDaysKey, mondayOf, rangeLabel} from './chat/range';
import {buckets, rollupChannels, ROLLUP_CHANNELS, type ChannelPeriod, type RollupInput} from './period-rollup';

export interface SeriesBucket {
  fromDay: string;
  toDay: string;
  label: string;
  /** Short axis label: "Oct 12" for a week, "Oct" for a month. */
  short: string;
  /** The span cuts this week or month short, so it has fewer days than a full one. */
  clipped: boolean;
  channels: ChannelPeriod[];
}
export interface Series {
  week: SeriesBucket[];
  month: SeriesBucket[];
}

/** More weekly bars than this are unreadable, so a longer span gets months only. */
export const MAX_WEEK_BUCKETS = 27;

function lastOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return addDaysKey(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
}

export function buildSeries(input: Pick<RollupInput, 'fromDay' | 'toDay' | 'digests' | 'website' | 'offline'>): Series {
  const crossesYears = input.fromDay.slice(0, 4) !== input.toDay.slice(0, 4);
  const make = (granularity: 'week' | 'month'): SeriesBucket[] =>
    rollupChannels({...input, channels: ROLLUP_CHANNELS, granularity}).map((b) => {
      const first = rangeLabel(b.fromDay, b.fromDay); // "Oct 12, 2026"
      const clipped =
        granularity === 'week'
          ? b.fromDay !== mondayOf(b.fromDay) || b.toDay !== addDaysKey(mondayOf(b.fromDay), 6)
          : b.fromDay.slice(8) !== '01' || b.toDay !== lastOfMonth(b.fromDay);
      const short = granularity === 'week' ? first.split(',')[0] : `${first.split(' ')[0]}${crossesYears ? ` '${b.fromDay.slice(2, 4)}` : ''}`;
      return {fromDay: b.fromDay, toDay: b.toDay, label: b.label, short, clipped, channels: b.channels};
    });
  return {
    week: buckets(input.fromDay, input.toDay, 'week').length > MAX_WEEK_BUCKETS ? [] : make('week'),
    month: make('month'),
  };
}
