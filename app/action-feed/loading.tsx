import {PageSkeleton} from '@/components/analyst/page-skeleton';

export default function Loading() {
  return <PageSkeleton label="action feed" tiles={0} rows={6} />;
}
