import {redirect} from 'next/navigation';

// The range view now lives on the Sales page. Old links keep working and keep their dates.
export default async function Page(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const sp = await props.searchParams;
  const q = new URLSearchParams({channel: 'all'});
  for (const key of ['from', 'to', 'span'] as const) {
    const v = Array.isArray(sp[key]) ? sp[key][0] : sp[key];
    if (v) q.set(key, v);
  }
  redirect(`/?${q.toString()}`);
}
