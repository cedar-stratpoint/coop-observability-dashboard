import {PageSkeleton} from '@/components/analyst/page-skeleton';

export default function Loading() {
  return <PageSkeleton label="review" tiles={0} chart rows={6} />;
}
