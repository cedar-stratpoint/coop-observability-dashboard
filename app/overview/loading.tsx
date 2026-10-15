import {PageSkeleton} from '@/components/analyst/page-skeleton';

export default function Loading() {
  return <PageSkeleton label="overview" chart rows={5} />;
}
