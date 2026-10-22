import 'server-only';
import {posClient, usingPosMock} from '../pos-data';
import type {ApiDeps} from './api';
import {supabaseImportStore} from './store-supabase';

/** The API's dependencies, or null when the archive database is not configured (mock mode): the routes then answer 503. */
export function shopeeImportDeps(): ApiDeps | null {
  if (usingPosMock()) return null;
  return {store: supabaseImportStore(posClient()), token: process.env.SHOPEE_IMPORT_TOKEN, now: () => new Date()};
}
