import type {ReactNode} from 'react';

// Settings is open to every view: the page itself decides what to show (Zoomy's
// digest preferences only in the Zoomy view; "Starting view" for anyone holding
// more than one view), so this layout no longer applies the Zoomy-only guard.
// NOTE: any new route added under app/settings/ is therefore NOT Zoomy-guarded —
// a page that reads Zoomy data must call requireZoomyData() itself.
export default function Layout({children}: {children: ReactNode}) {
  return <>{children}</>;
}
