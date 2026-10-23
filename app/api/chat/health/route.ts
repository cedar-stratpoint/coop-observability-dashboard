import {auth} from '@/auth';
import {describeChatEnv} from '@/src/chat/health';
import {crmHealth} from '@/src/chat/crm/health';
import {exploreHealth} from '@/src/chat/explore-setup';
import {safeReason} from '@/src/chat/server';
import {chatReadClient} from '@/src/chat/read/client';
import {loadMetricData} from '@/src/chat/read/metric-data';
import {assertChatReadable} from '@/src/chat/read/mode';
import {devAuthEnabled, DEV_SESSION} from '@/src/dev-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET /api/chat/health: for a signed-in person, what this deployment sees (booleans and kinds, never values) and the result of one
// real read through the read-only path, so a fallback to digest-only has a visible reason. Reads only; writes nothing.
export async function GET() {
  const session = devAuthEnabled() ? DEV_SESSION : await auth();
  if (!session?.user) return new Response('Please sign in.', {status: 401});

  const env = describeChatEnv(process.env);
  const readable = assertChatReadable(process.env);
  let load: {ok: true; orders: number} | {ok: false; reason: string};
  if (!readable.ok) {
    load = {ok: false, reason: readable.message};
  } else {
    try {
      const {client} = chatReadClient({mode: readable.mode});
      const data = await loadMetricData(client, readable.mode);
      load = {ok: true, orders: data.orders.length};
    } catch (e) {
      load = {ok: false, reason: safeReason(e)};
    }
  }
  const explore = await exploreHealth(process.env, session.user.email ?? null);
  const crm = await crmHealth(process.env);
  return Response.json({live: load.ok, load, env, explore, crm}, {headers: {'cache-control': 'no-store'}});
}
