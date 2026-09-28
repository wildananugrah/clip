import { cn } from '../lib/cn'

/** A thin quota bar. `tone` picks ink for what you've used, sand for a ceiling. */
export function Meter({
  value,
  tone = 'ink',
  className,
}: {
  value: string
  tone?: 'ink' | 'violet' | 'sand'
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-[3px] bg-ink/8', className)}>
      <div
        className={cn(
          'h-full',
          tone === 'ink' && 'bg-ink',
          tone === 'violet' && 'rounded-[3px] bg-violet transition-[width] duration-300 ease-linear',
          tone === 'sand' && 'bg-sand-deeper',
        )}
        style={{ width: value }}
      />
    </div>
  )
}
