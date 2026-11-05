// Business Health Report: every explanatory sentence lives here, shown only inside an InfoTip (components/analyst/info-tip.tsx).
// Visible UI keeps state and safety text only (status words, blockers, locks, errors).
export const PLAN_HELP = {
  sources: "GMV actuals come from Coop: Events from POS event orders, Website from CRM orders other than cancelled, voided and refunded, Marketplace from Shopee and Lazada daily sales. Only the workbook's input rows are typed by admins: the costs paid, stock bought, funding and one-time payments (thousands of pesos; empty means not entered yet, 0 means a real zero), plus optional ROAS. Everything the workbook calculates is calculated here by the same formula: CM1 to EBITDA, cash at month end (last cash + EBITDA + COGS − stock bought + funding − settlement − freight, starting from the opening cash an admin types once; the workbook has no opening-cash cell and starts from 0), inventory coverage, active customers and CAC. A calculated cell waits until every input behind it, this month and earlier, is in. An empty cell says waiting: nothing is there for the month, it does not mean zero. A cell tagged workbook or owner was prefilled once from the Business Plan workbook with a known actual (opening stock, opening customers, and the Sep'26 funding the owner confirmed received); an admin can overwrite it, and the tag then goes. Opening cash, settlement, freight and the other months' funding are not known, so they stay empty.",
  readOnly: 'View only. A Coop Admin or Zoomy admin can edit. You can see these numbers but not change them.',
  grid: (requiredCount: number) => `Type the ${requiredCount} lines into the open cells, in ₱ thousands. Each has its target under it: a cost under target is good, over is bad; funding and payments are not judged. Coloured rows are calculated like the Excel and checked against target. Amber cells are still missing. Enter jumps to the next empty one. Opening cash is typed once; cash waits until it is in.`,
  cardWaiting: 'Waiting for the lines this needs.',
  cashNoOpening: 'Waiting for the opening cash: type it in the grid (cash flow items). Then check against your bank.',
  cashCheckBank: 'Check against your bank: this should match the bank balance at month end.',
  runway: 'Info only: cash ÷ 3-month average net burn. Shows once cash has fallen in 2+ months (needs 3 months of cash).',
  modelled: 'Modelled from plan assumptions.',
  cashChart: 'Cash is calculated, so the solid line appears once the opening cash is typed and a month has all its inputs typed (and every month before it).',
  stockChart: (cover: number | null) => `${cover !== null ? `Purchases needed to hold ${cover.toFixed(1)} months of cover, ` : ''}₱'000. Last closed month highlighted.`,
  openingCash: (canEdit: boolean, typed: boolean) => (!typed ? (canEdit ? 'Type your bank balance at Aug 1: cash waits for it.' : 'Not typed yet: cash waits for it.') : 'Check this against your bank.'),
  closeMonth: (requiredCount: number) => `Needs all ${requiredCount} lines and complete GMV.`,
  notTyped: 'Not typed yet.',
} as const;
