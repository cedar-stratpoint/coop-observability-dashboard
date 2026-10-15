// Ask Coop's runtime catalog, GENERATED from COOP/knowledge/data-catalog/ by build.mjs (spec 2.0). Never edit catalog.json by hand:
// edit the markdown, run `node knowledge/data-catalog/build.mjs`, commit the JSON. Pure. Neutral on access: callers filter closed
// names with src/chat/explore/secret-names.ts.
import raw from './catalog.json';

export interface CatalogTable {name: string; domain: string; about: string; columns: string; prefer: string | null; testOrders: string | null}
export interface CatalogDomain {id: string; title: string; tables: string[]}
export interface CatalogPage {route: string; title: string; shows: string; data: string; domains: string[]; fenced: boolean; access: string; redirectTo: string | null}
export interface CatalogApi {id: string; source: string; askCoop: string}
export interface CatalogTerm {term: string; default: string; alternatives: string; askWhen: string}
export interface Catalog {version: 1; domains: CatalogDomain[]; tables: Record<string, CatalogTable>; pages: CatalogPage[]; apis: CatalogApi[]; terms: CatalogTerm[]}

export const CATALOG_DATA = raw as unknown as Catalog;

export const catalogTable = (name: string): CatalogTable | null => CATALOG_DATA.tables[name] ?? null;
