/**
 * Shapes returned by the Zoomy CRM Worker's read API (/api/*). Only the fields
 * the dashboard renders are modelled — the endpoints also return a `raw` blob
 * of the original Shopify payload, which is heavy and full of PII we have no
 * use for here, so it is dropped at the boundary in crm-data.ts.
 */

export type CrmMetrics = {
  customers: number;
  orders: number;
  totalRevenue: number;
  ordersLast7Days: number;
  revenueLast7Days: number;
  abandonedActive: number;
  recovered: number;
  reminded: number;
  revenueRecovered: number;
  recoveryRate: number;
};

export type CrmCustomer = {
  shopifyCustomerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  ordersCount: number | null;
  totalSpent: string | null;
  membershipTier: string | null;
  petName: string | null;
  petBirthday: string | null;
  emailMarketingState: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CrmOrder = {
  shopifyOrderId: string;
  shopifyCustomerId: string | null;
  orderNumber: string | null;
  email: string | null;
  totalPrice: string | null;
  currency: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  createdAt: string | null;
  fulfilledAt: string | null;
  reviewRequestSentAt: string | null;
  reviewSubmittedAt: string | null;
  // Shopify line items as the CRM sends them (a JSON string). Only the Overview's
  // custom date range reads it (units + top products) — see src/custom-range.ts.
  lineItems?: string | null;
  // Line price and quantity from `/api/orders?lines=1` (Business Health Website GMV = Shopify gross sales). Only when the Worker sent a
  // lines array; nothing about the buyer or the product.
  lines?: CrmOrderLine[];
};

export type CrmOrderLine = {price: number | null; quantity: number | null};

export type CrmCheckout = {
  shopifyCheckoutId: string;
  email: string | null;
  abandonedCheckoutUrl: string | null;
  totalPrice: string | null;
  currency: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  convertedAt: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  reachedPaymentAt: string | null;
  /** When the one-off RETURN30 win-back went out (null = never sent). */
  winbackSentAt: string | null;
  /**
   * How far the shopper got. Derived server-side from the Shopify payload (see
   * crm-data.ts) so the browser gets the label without the raw blob's PII.
   */
  stage: CheckoutStage;
};

/**
 * 'Shipping' is the furthest stage Shopify lets us see: whether someone engaged
 * the payment form lives inside Shopify's secure iframe and is never persisted
 * unless the payment completes — at which point it is an order, not a cart.
 * 'Payment' therefore only appears for carts the CRM saw reach payment.
 */
export type CheckoutStage = 'Started' | 'Email' | 'Shipping' | 'Payment';

export type CrmBirthdayVoucher = {
  id: number;
  email: string;
  year: number;
  tier: string;
  code: string;
  amount: string;
  expiresAt: string | null;
  sentAt: string;
};

/** Membership settings, straight from the Shopify metafield the admin edits. */
export type CrmMembershipConfig = {
  platinumThreshold: number;
  programStart: string;
};
