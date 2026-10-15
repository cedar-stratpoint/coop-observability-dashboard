import type {Brand} from '@/src/brands';
import {cn} from '@/lib/utils';

// A company's wordmark (see src/brands.ts). `size` is the wordmark's font size in px;
// the tagline scales with it. Decorative by default — callers provide the accessible
// name (the company name) next to it or via aria-label.

export function BrandMark({brand, size = 15, className}: {brand: Brand; size?: number; className?: string}) {
  // Theme-aware brand color via CSS variables (light / dark values from src/brands.ts).
  const tone = brand.color
    ? {style: {['--brand-l' as string]: brand.color.light, ['--brand-d' as string]: brand.color.dark}, cls: 'text-[var(--brand-l)] dark:text-[var(--brand-d)]'}
    : {style: {}, cls: ''};
  if (brand.style === 'thin') {
    return (
      <span
        aria-hidden
        className={cn('font-sans leading-none font-light whitespace-nowrap uppercase', tone.cls, className)}
        style={{...tone.style, fontSize: size, letterSpacing: '0.3em'}}
      >
        {brand.wordmark}
      </span>
    );
  }
  return (
    <span aria-hidden className={cn('inline-flex flex-col leading-none whitespace-nowrap', tone.cls, className)} style={tone.style}>
      <span className="font-sans font-extrabold tracking-tight" style={{fontSize: size}}>
        {brand.wordmark}
      </span>
      {brand.tagline && (
        <span className="font-sans font-bold" style={{fontSize: Math.max(7, size * 0.42), letterSpacing: '0.32em', marginTop: size * 0.12}}>
          {brand.tagline}
        </span>
      )}
    </span>
  );
}
