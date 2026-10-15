import {PageSkeleton} from '@/components/analyst/page-skeleton';

export default function Loading() {
  return <PageSkeleton label="product" chart rows={5} />;
}
