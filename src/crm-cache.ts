/**
 * Cache window and tag for the CRM live-proxy readers.
 *
 * The window keeps a page load and its link prefetch from hitting the Worker
 * twice; the tag exists so the page's Refresh button can invalidate on demand
 * (src/crm-actions.ts) rather than waiting the window out.
 */
export const CRM_TAG = 'crm-live';

/** Seconds a cached CRM read may be stale. The CRM is webhook-fed, so a new
 * order lands within seconds and shows up on the next read either way. */
export const CRM_CACHE_REVALIDATE = 60;

/**
 * Tag for the Business Health Report's Website read (BHR-09). That read is cached with no time limit: it re-reads the Worker only when
 * someone presses the report's Refresh (syncHealthReport in src/plan-actions.ts expires this tag), not on every page load.
 */
export const PLAN_WEB_TAG = 'plan-gmv-web';
