import {VERSION_LABEL, VERSION_COLOR} from '@/src/goldline-triage-format';
import type {FormVersion} from '@/src/goldline-extract';
import {cn} from '@/lib/utils';

// The detected inventory-form layout as a small colored pill (Legacy plum, V1 blue, V2
// ochre), matching the triage board and the uploads version filter. Nothing for an
// unknown or missing version — a page that isn't a read inventory page just shows no pill.
export function VersionPill({version, className}: {version?: string | null; className?: string}) {
  if (!version || version === 'unknown') return null;
  const v = version as FormVersion;
  const color = VERSION_COLOR[v];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', className)}
      style={{color, background: `color-mix(in oklab, ${color} 16%, transparent)`}}
      title={`${VERSION_LABEL[v]} inventory form`}
    >
      {VERSION_LABEL[v]}
    </span>
  );
}
