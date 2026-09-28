import { cn } from '../lib/cn'

/**
 * The mark: a tilted ink chip with a lime cut out of it — a frame with the
 * good bit lifted from it.
 *
 * Inverted in the dark theme: ink turns cream there, and lime on cream all but
 * disappears, so the chip goes lime with a dark cut instead.
 */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const sm = size === 'sm'
  return (
    <div className="flex items-center gap-[9px]">
      <div
        className={cn(
          'flex flex-none -rotate-[8deg] items-center justify-center bg-ink dark:bg-lime',
          sm ? 'size-[22px] rounded-[7px]' : 'size-6 rounded-[8px]',
        )}
      >
        <div className={cn('rounded-[2px] bg-lime dark:bg-cream', sm ? 'size-[8px]' : 'size-[9px]')} />
      </div>
      <span
        className={cn('font-semibold text-ink', sm ? 'text-[13.5px]' : 'text-[14.5px]')}
      >
        clip2
      </span>
    </div>
  )
}
