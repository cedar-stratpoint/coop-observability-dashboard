import type {ExploreErrorCode} from '../../src/chat/explore/types';
export interface DirectReadScan {
  /** The rows the database returns (pinned against the real database by the integration test). */
  raw: unknown[][];
  /** Planted strings: present in raw, absent after the scan. */
  secrets?: string[];
  /** Strings that must still read after the scan. */
  visible?: string[];
  /** Cost bound for the whole query (integration) and the scan (no database). */
  maxMs?: number;
  /** An E_DB_* refusal with no rows also counts as blocked. */
  mayError?: boolean;
  /** RESIDUAL and CONTROL rows: the exact scanner output today. */
  scrubbed?: unknown[][];
  /** RESIDUAL rows: the whole value the pieces come from (the scanner hides it whole). */
  whole?: string;
}
export interface DirectReadAttack {
  id: string;
  category: string;
  sql: string;
  parser: ExploreErrorCode | 'ok';
  db: 'MUST' | 'PARSER' | 'SCAN' | 'RESIDUAL' | 'CONTROL';
  scan?: DirectReadScan;
}
export declare const DIRECT_READ_ATTACKS: DirectReadAttack[];
export declare const DIRECT_READ_RESIDUALS: DirectReadAttack[];
export declare const DIRECT_READ_CONTROLS: DirectReadAttack[];
