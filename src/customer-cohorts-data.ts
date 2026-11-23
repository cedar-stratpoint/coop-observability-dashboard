import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {CRM_CACHE_REVALIDATE, CRM_TAG} from './crm-cache';
import {loadCohortRows, type CustomerCohort} from './customer-cohorts';
import {posClient, usingPosMock} from './pos-data';

/**
 * Saved customer cohorts (customer_cohorts, RET-10 Stage 9A): the rules only, never members. Read with the service-role key
 * server-side only (RLS on, no policies: the anon key sees nothing). Null = unavailable (mock mode, the table not applied yet, or
 * a failed read): the Website CRM page then says saved cohorts are unavailable and keeps the built-ins. Read only.
 *
 * Tagged CRM_TAG too, so the Website CRM page's Refresh button re-reads it with the rest of the page.
 */
export const CUSTOMER_COHORTS_TAG = 'customer-cohorts';

export const getCustomerCohorts = cache((): Promise<CustomerCohort[] | null> =>
  usingPosMock() ? Promise.resolve(null) : cohortsCached(),
);

const cohortsCached = unstable_cache(async (): Promise<CustomerCohort[] | null> => {
  const supabase = posClient();
  // Paged (fetchAllRows inside loadCohortRows): group then name for the menu, the PK `id` as the unique tiebreaker.
  return loadCohortRows((from, to) =>
    supabase
      .from('customer_cohorts')
      .select('id,group_name,name,rule,created_by,created_at,updated_at')
      .order('group_name', {ascending: true})
      .order('name', {ascending: true})
      .order('id', {ascending: true})
      .range(from, to));
}, ['customer-cohorts'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CUSTOMER_COHORTS_TAG, CRM_TAG]});
