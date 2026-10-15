// The in-app destinations Ask Coop may link to (<go> line), from the runtime catalog (spec 3.1). The client keeps the same list as a
// literal (components/analyst/coop-chat.tsx APP_PATHS) so the catalog JSON is not shipped to the browser; a test pins them equal.
import {CATALOG_DATA} from './catalog';

const CHANNEL_LINKS = ['/?channel=all', '/?channel=shopee', '/?channel=lazada', '/?channel=website'] as const;

export const GO_PATHS: readonly string[] = [
  ...CATALOG_DATA.pages.filter((p) => !p.fenced && p.redirectTo === null && !p.route.includes('[') && !p.access.startsWith('n/a')).map((p) => p.route),
  ...CHANNEL_LINKS,
];
