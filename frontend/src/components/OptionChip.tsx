import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

/** A small selectable box used for clip length and output formats. */
export function OptionChip({
  selected,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={cn(
        'flex flex-1 cursor-pointer items-center justify-center border text-[12.5px] font-medium text-ink transition-colors',
        selected ? 'border-violet bg-violet/5' : 'border-ink/14 bg-paper hover:bg-cream',
        className,
      )}
      {...rest}
    />
  )
}
