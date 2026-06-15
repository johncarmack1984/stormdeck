import { cn } from '@/lib/utils';

/**
 * The small colour chip shown beside a layer's label in the panel. Pass the
 * same Tailwind `bg-*` classes the layer paints with so the legend matches the
 * map. (Class strings must be literals here for Tailwind's static scan.)
 */
export function Swatch({ className }: { className: string }) {
  return <span className={cn('inline-block size-2.5 rounded-xs', className)} />;
}
