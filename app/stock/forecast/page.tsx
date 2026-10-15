import {redirect} from 'next/navigation';

// The Forecast tab merged into the Inventory board (counts + forecast + supply in one
// view). Kept as a redirect so old links and bookmarks still land in the right store.
export default async function Page(props: {searchParams: Promise<{store?: string}>}) {
  const {store} = await props.searchParams;
  redirect(store ? `/stock?store=${encodeURIComponent(store)}` : '/stock');
}
