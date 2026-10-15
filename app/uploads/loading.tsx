import {PageSkeleton} from '@/components/analyst/page-skeleton';

export default function Loading() {
  return <PageSkeleton label="uploads" tiles={0} rows={6} />;
}
