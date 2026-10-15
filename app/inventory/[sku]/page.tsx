import {notFound} from 'next/navigation';
import {getProductDetail} from '@/src/pos-product-detail';
import {getBoxmeSkuDetail} from '@/src/boxme-inventory-data';
import {ProductDetailView} from '@/components/analyst/product-detail';
import {BoxmeSkuCard} from '@/components/analyst/boxme-sku-card';

export const dynamic = 'force-dynamic';

export default async function Page(props: {params: Promise<{sku: string}>; searchParams: Promise<{channel?: string}>}) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  const sku = decodeURIComponent(params.sku);
  const [detail, boxme] = await Promise.all([getProductDetail(sku), getBoxmeSkuDetail(sku).catch(() => null)]);
  if (!detail) notFound();
  const fromOnline = searchParams.channel === 'online' || searchParams.channel === 'boxme';
  return (
    <ProductDetailView detail={detail} backHref={fromOnline ? '/inventory?channel=online' : '/inventory'}
      boxme={<BoxmeSkuCard detail={boxme} />} boxmeFirst={fromOnline} />
  );
}
