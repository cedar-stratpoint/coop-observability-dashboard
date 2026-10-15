import {cn} from '@/lib/utils';

// A small color-coded file-type tag (plan §07d): CSV green, PDF violet, spreadsheet
// red, anything else neutral. Read from the file name's extension so it also covers
// rejected files we never stored. Color is an aid, not the only cue — the type is
// always written out.

type Kind = {label: string; hue: number | null};

function kindOf(filename: string): Kind {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'csv') return {label: 'CSV', hue: 150};
  if (ext === 'pdf') return {label: 'PDF', hue: 295};
  if (ext === 'xls' || ext === 'xlsx') return {label: 'XLS', hue: 25};
  return {label: (ext || 'file').slice(0, 4).toUpperCase(), hue: null};
}

export function FileTypeBadge({filename, className}: {filename: string; className?: string}) {
  const k = kindOf(filename);
  return (
    <span
      style={k.hue == null ? undefined : {['--hue' as string]: k.hue}}
      className={cn(
        'inline-flex h-5 min-w-9 shrink-0 items-center justify-center rounded px-1.5 font-mono text-[10px] font-semibold tracking-wide',
        k.hue == null
          ? 'bg-muted text-muted-foreground'
          : 'bg-[oklch(0.62_0.12_var(--hue)/0.15)] text-[oklch(0.45_0.12_var(--hue))] dark:bg-[oklch(0.72_0.12_var(--hue)/0.16)] dark:text-[oklch(0.82_0.11_var(--hue))]',
        className,
      )}
    >
      {k.label}
    </span>
  );
}
