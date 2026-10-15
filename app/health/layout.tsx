import type {ReactNode} from 'react';
import {requireZoomyData} from '@/src/active-context';

// Zoomy-only section. These pages read Zoomy data (no company dimension), so a
// non-Zoomy viewer (Goldline user / data-blind Coop Admin) is redirected to
// /uploads. No-op for Zoomy and for local dev-auth bypass.
export default async function Layout({children}: {children: ReactNode}) {
  await requireZoomyData();
  return <>{children}</>;
}
