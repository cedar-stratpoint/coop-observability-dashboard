// Pure nav helpers: which sidebar item is the current page. Lives outside the shell (a client component) so it is unit-tested.

/** True when `pathname` is `base` or a subpath of it. A sibling that merely shares a prefix is not: `/health-report` is not under `/health`. */
export const pathUnder = (base: string, pathname: string): boolean => pathname === base || pathname.startsWith(`${base}/`);

// Active detection. '/' is the Overview home ONLY without a channel; '/?channel=' is the Sales compare view. Everything else matches by path.
export const leafActive = (href: string, pathname: string, channel: string | null): boolean => {
  if (href === '/') return pathname === '/' && !channel;
  if (href === '/?channel=all') return pathname === '/' && Boolean(channel);
  // Transactions (/offline-sales/orders) and Events (/offline-sales/events) live under /offline-sales, so all three must not light up
  // together: Offline Sales owns /offline-sales and any other subpath, while Transactions and Events each own their own subtree. This
  // transfers the highlight to the child when you open it from the Offline Sales page.
  if (href === '/offline-sales') {
    return pathname === '/offline-sales'
      || (pathname.startsWith('/offline-sales/')
        && !pathname.startsWith('/offline-sales/events')
        && !pathname.startsWith('/offline-sales/orders'));
  }
  if (href === '/offline-sales/orders') return pathname.startsWith('/offline-sales/orders');
  if (href === '/offline-sales/events') return pathname.startsWith('/offline-sales/events');
  // Goldline: SKU linking (/stock/skus), Restock (/stock/restock), Orders (/stock/orders) and Audit (/stock/audit) own their subtrees; Inventory owns the rest of /stock.
  if (href === '/stock') return pathUnder('/stock', pathname) && !pathname.startsWith('/stock/skus') && !pathname.startsWith('/stock/restock') && !pathname.startsWith('/stock/orders') && !pathname.startsWith('/stock/audit');
  return pathUnder(href.split('?')[0], pathname);
};
