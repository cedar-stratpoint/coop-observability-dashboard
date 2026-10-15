// Coop's static brand knowledge base — reference facts Coop may use to interpret
// data and answer definitional / brand questions. This is REFERENCE, not live
// data: period numbers always come from the digest, never from here.
//
// ✏️  This is the one place to edit Coop's background knowledge. Keep entries
//     TRUE — anything added here, Coop may state as fact. Leave the "Policies"
//     section blank until the team confirms real values; Coop is told to defer
//     on anything not present.

export const COOP_KNOWLEDGE = `
### The brand
- **Zoomy Treats** is a Philippine (PH) premium pet-treats brand for **dogs and cats**. Currency is the Philippine peso (₱ / PHP).
- Product lines: freeze-dried single-protein munchies (beef liver, chicken, duck, salmon), meat jerky, cat grass / superfood cubes, multivitamin chews, and "Buy 1 Take 1" meaty-treat bundles.
- Selling channels:
  - **Shopee** — marketplace; data from manual Seller-Centre exports.
  - **Lazada** — marketplace; data from the Lazada Open Platform API.
  - **Website** — the Shopify store (zoomyforpets.com), with **PawPal**, an on-site AI shopping assistant whose chats feed customer/topic signals.

### Metric glossary (how to read the numbers)
- **ROAS** — Return on ad spend = ad revenue ÷ ad spend, shown as a ratio (e.g. 3.29×). **Higher is better.**
- **ACOS** — Advertising cost of sale = ad spend ÷ ad revenue, a percentage (roughly 1 ÷ ROAS). **Lower is better;** ~30% or below is healthy, ~40%+ warrants trimming spend.
- **AOV** — Average order value = revenue ÷ orders. "Blended AOV" is across all selected channels.
- **GMV** — Gross merchandise value (Shopee/Lazada ad-attributed sales).
- **CTR** — Click-through rate = clicks ÷ impressions (%). **Add-to-cart rate** and **visit-to-buy rate** measure funnel steps.
- **Net vs gross revenue** — net excludes cancellations, returns, and discounts; gross does not.

### Advertising products (what "ad spend" means per channel)
- **Shopee** — on-platform Product Ads (e.g. the "Shop GMV Max" campaign); metrics come from the "Ads Overall" export (spend, GMV, ROAS, ACOS).
- **Lazada** — **Sponsored Max**, the on-platform ads suite; Coop reads the combined aggregate (Sponsored Max + Mega Sales Accelerator + Sponsored Discovery). Its report lags the seller-center UI by ~1 day.
- **Website** — Meta (Facebook/Instagram) ads. **Not yet connected**, so Website ad spend / ROAS is unavailable; say so rather than guessing.

### Reporting
- A digest covers a window of varying length (weekly or about a month), the "period". Every answer names the window it used. Comparisons "vs last month" use the compact prior-period figures provided.

### Policies (team-maintained — currently unspecified)
- Shipping, returns/refunds, and current promotions are **not loaded** here yet. If asked, say you don't have the store's policy details and suggest checking with the team, rather than inventing them.
`.trim();
