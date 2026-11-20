// The server seam for saved customer cohorts in Ask Coop (RET-10 Stage 9B, plan knowledge/tasks/2026-11-12-customer-cohorts-stage9.md). It lives
// outside src/chat on purpose: src/chat may not import the data layer (test/chat-architecture.test.ts). It reuses the Website CRM page's own
// read (rules only, never members), so the chat filters and drafts against exactly the cohorts a signed-in owner sees there. READ ONLY: the
// actions (src/customer-cohorts-actions.ts) are never imported here; a draft is saved only by a person clicking Save cohort. Null = not set up.
import {getCustomerCohorts} from '@/src/customer-cohorts-data';

export const loadSavedCohorts = getCustomerCohorts;
