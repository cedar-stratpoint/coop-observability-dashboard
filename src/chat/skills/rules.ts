// The rule inventory for the Ask Coop Data Analyst skill (design 4d). Every `[ID]` tag in the skill markdown must be
// listed here exactly once. `enforcedBy: 'code'` rules carry the ⚙ tag in the text and need a test titled with the id.
import {SMALL_SAMPLE_N} from '../checks';
import {KPI_MAX, PIE_MAX_SEGMENTS, SERIES_FOLD_AT, TABLE_MIN_CLASSES} from '../recommend-view';

export type RuleEnforcement = 'code' | 'guide';

export const RULES: readonly {id: string; enforcedBy: RuleEnforcement; where: string}[] = [
  {id: 'THINK-01', enforcedBy: 'guide', where: 'guide'},
  {id: 'THINK-02', enforcedBy: 'guide', where: 'guide'},
  {id: 'THINK-03', enforcedBy: 'guide', where: 'guide'},
  {id: 'THINK-04', enforcedBy: 'guide', where: 'guide'},
  {id: 'THINK-05', enforcedBy: 'guide', where: 'guide'},
  {id: 'THINK-06', enforcedBy: 'guide', where: 'guide'},
  {id: 'THINK-07', enforcedBy: 'guide', where: 'guide'},
  {id: 'ANL-01', enforcedBy: 'guide', where: 'guide'},
  {id: 'ANL-02', enforcedBy: 'guide', where: 'guide'},
  {id: 'ANL-03', enforcedBy: 'guide', where: 'guide'},
  {id: 'ANL-04', enforcedBy: 'guide', where: 'guide'},
  {id: 'ANL-05', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-01', enforcedBy: 'code', where: 'src/chat/metrics-registry.ts one definition per metric'},
  {id: 'BI-02', enforcedBy: 'code', where: 'src/chat/checks.ts reconciles'},
  {id: 'BI-03', enforcedBy: 'code', where: 'src/chat/metrics-registry.ts one grain, voided excluded, pick lines not summed'},
  {id: 'BI-04', enforcedBy: 'code', where: 'src/chat/checks.ts round_row_count'},
  {id: 'BI-05', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-06', enforcedBy: 'code', where: 'src/chat/query-metric.ts "No tag" bucket kept on its own'},
  {id: 'BI-07', enforcedBy: 'code', where: 'src/chat/query-metric.ts shares from unrounded values'},
  {id: 'BI-08', enforcedBy: 'code', where: 'src/chat/query-metric.ts "Showing the first N of M" caveat (claim restriction is guide)'},
  {id: 'BI-10', enforcedBy: 'code', where: 'src/chat/range.ts previous period of equal length'},
  {id: 'BI-11', enforcedBy: 'code', where: 'src/chat/query-metric.ts empty earlier period is null, never 0'},
  {id: 'BI-12', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-13', enforcedBy: 'code', where: 'src/chat/checks.ts small_sample'},
  {id: 'BI-14', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-15', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-20', enforcedBy: 'code', where: 'src/chat/metrics-registry.ts method line returned with allocated measures'},
  {id: 'BI-21', enforcedBy: 'code', where: 'src/chat/metrics-registry.ts price at the sale date'},
  {id: 'BI-22', enforcedBy: 'code', where: 'src/chat/checks.ts reconciles (allocation)'},
  {id: 'BI-23', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-24', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-25', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-30', enforcedBy: 'code', where: 'src/chat/coverage.ts source and coverage in the result'},
  {id: 'BI-31', enforcedBy: 'code', where: 'src/chat/checks.ts mock_source'},
  {id: 'BI-32', enforcedBy: 'code', where: 'src/chat/checks.ts partial_coverage'},
  {id: 'BI-33', enforcedBy: 'code', where: 'src/chat/checks.ts untagged_share'},
  {id: 'BI-34', enforcedBy: 'code', where: 'src/chat/checks.ts small_sample'},
  {id: 'BI-35', enforcedBy: 'guide', where: 'guide'},
  {id: 'BI-36', enforcedBy: 'guide', where: 'guide'},
  {id: 'VIZ-01', enforcedBy: 'code', where: 'src/chat/recommend-view.ts one row is a tile, at most KPI_MAX tiles'},
  {id: 'VIZ-02', enforcedBy: 'code', where: 'src/chat/recommend-view.ts the form follows the job'},
  {id: 'VIZ-03', enforcedBy: 'code', where: 'src/chat/recommend-view.ts table plus top-7 chart past TABLE_MIN_CLASSES'},
  {id: 'VIZ-04', enforcedBy: 'code', where: 'src/chat/recommend-view.ts one chart per unit; src/chat/tool-defs.ts has no axis option'},
  {id: 'VIZ-05', enforcedBy: 'code', where: 'src/chat/entity-colors.ts color follows the entity, gray for No tag and Other'},
  {id: 'VIZ-06', enforcedBy: 'code', where: 'src/chat/recommend-view.ts auto never draws a pie; PIE_MAX_SEGMENTS'},
  {id: 'VIZ-07', enforcedBy: 'code', where: 'src/chat/recommend-view.ts SERIES_FOLD_AT'},
  {id: 'VIZ-08', enforcedBy: 'code', where: 'src/chat/recommend-view.ts every chart carries a table twin with every row'},
  {id: 'VIZ-09', enforcedBy: 'guide', where: 'guide'},
  {id: 'VIZ-10', enforcedBy: 'guide', where: 'guide'},
  {id: 'VIZ-11', enforcedBy: 'guide', where: 'guide'},
  {id: 'VIZ-13', enforcedBy: 'guide', where: 'guide'},
  {id: 'VIZ-12', enforcedBy: 'code', where: 'src/chat/render-executors.ts (chart-first nudge)'},
  {id: 'PREF-01', enforcedBy: 'code', where: 'src/chat/recommend-view.ts tier A honored as asked'},
  {id: 'PREF-02', enforcedBy: 'code', where: 'src/chat/recommend-view.ts tier B folds or notes, the twin keeps every row'},
  {id: 'PREF-03', enforcedBy: 'code', where: 'src/chat/recommend-view.ts tier C substitutes the nearest valid form with a reason'},
  {id: 'PREF-04', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-01', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-02', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-04', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-05', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-08', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-09', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-10', enforcedBy: 'guide', where: 'guide'},
  {id: 'DASH-11', enforcedBy: 'guide', where: 'guide'},
  // Explore mode (run_query). These tags appear only in the explore variant of the skill (topics/sql-explore.md).
  {id: 'EXP-01', enforcedBy: 'code', where: 'src/chat/explore/parse.ts E_SELECT_STAR: name every column'},
  {id: 'EXP-02', enforcedBy: 'code', where: 'src/chat/explore/parse.ts + role coop_explore_ro: one read-only SELECT on open public relations; secret and tenant names refused'},
  {id: 'EXP-03', enforcedBy: 'code', where: 'src/chat/explore/executor.ts result caveat and block label: Exploratory, not a registered metric, SQL shown'},
  {id: 'EXP-04', enforcedBy: 'code', where: 'src/chat/loop.ts number check in enforce mode for Explore turns'},
  {id: 'EXP-05', enforcedBy: 'code', where: 'src/chat/explore/parse.ts lint W_NO_STATUS_FILTER + src/chat/explore/client.ts SET LOCAL timezone Asia/Manila'},
  {id: 'EXP-06', enforcedBy: 'guide', where: 'guide'},
  {id: 'EXP-07', enforcedBy: 'code', where: 'src/chat/recommend-view.ts decideTwoDim: two categories + one measure pivot, GROUPED_MAX_SERIES, small multiples, untagged note over UNTAGGED_NOTE_SHARE'},
  {id: 'EXP-08', enforcedBy: 'guide', where: 'guide'},
  {id: 'EXP-09', enforcedBy: 'guide', where: 'guide'},
  {id: 'EXP-10', enforcedBy: 'guide', where: 'guide'},
  {id: 'EXP-11', enforcedBy: 'guide', where: 'guide'},
  {id: 'PAGE-01', enforcedBy: 'guide', where: 'guide'},
];

/** Numbers the skill text uses as `{{NAME}}` placeholders, taken from code so the text cannot drift. */
export const SKILL_CONSTANTS: Record<string, number> = {SMALL_SAMPLE_N, KPI_MAX, PIE_MAX_SEGMENTS, TABLE_MIN_CLASSES, SERIES_FOLD_AT};

export const SKILL_TOPICS = ['bi-reconciliation', 'period-comparison', 'allocation-and-prices', 'data-quality', 'viz-forms', 'dashboard-composition', 'page-context'] as const;

/** Topics appended after SKILL_TOPICS, only in the explore variant. */
export const EXPLORE_TOPICS = ['sql-explore'] as const;

/** Topics appended last, only when the website CRM tools are sent (Train 4). */
export const CRM_TOPICS = ['crm-tools'] as const;
