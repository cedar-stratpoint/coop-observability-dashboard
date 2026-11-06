import type {ReactNode} from 'react';
import {requireHealthReportAccess} from '@/src/active-context';

// Business Health Report: a Zoomy data viewer or a Coop Admin. NOT requireZoomyData (that bounces the Coop Admin). Goldline is sent home.
export default async function Layout({children}: {children: ReactNode}) {
  await requireHealthReportAccess();
  return <>{children}</>;
}
