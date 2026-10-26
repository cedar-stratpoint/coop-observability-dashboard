// Lets the shipped import routes accept a worker token (sales_overview only, see src/shopee-import/api.ts) without knowing about workers.
import {workerForToken} from './api';
import type {SyncStore} from './store';

export const workerAuthFor = (store: SyncStore) => async (bearer: string): Promise<boolean> => (await workerForToken(store, bearer)) !== null;
