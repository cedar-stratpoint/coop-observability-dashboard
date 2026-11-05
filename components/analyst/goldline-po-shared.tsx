import type {PoStatus} from '@/src/goldline-po';
import {PO_STATUS_LABEL} from '@/src/goldline-po';
import {ToneChip} from '@/components/analyst/goldline-ops-shared';

// Shared bits of the Orders pages (F12): the PO status chip and the peso format used on
// the paper form (no decimals unless the price has them).

const STATUS_TONE: Record<PoStatus, string | null> = {
  empty: null,
  shipped: 'var(--primary)',
  partly_received: 'var(--status-warn)',
  received: 'var(--status-good)',
};

export function PoStatusChip({status}: {status: PoStatus}) {
  return <ToneChip tone={STATUS_TONE[status]}>{PO_STATUS_LABEL[status]}</ToneChip>;
}

export const money = (n: number | null) => (n == null ? '·' : n.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 2}));
