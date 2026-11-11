// The server seam for the chat's `compare_sku` tool (contract knowledge/tasks/2026-10-26-sku-compare-contract.md). It lives outside src/chat on purpose:
// src/chat may not import the data layer (test/chat-architecture.test.ts). It reuses the two server loaders behind the comparison, which are soft by design
// (mock mode, a missing table or a failed read gives no rows, and the comparison then shows the channel unmapped or without data instead of failing).
import {loadAliasRows, loadShopeeSkuRows} from '@/src/sku-compare-data';

export const skuSource = {aliases: loadAliasRows, shopee: loadShopeeSkuRows};
