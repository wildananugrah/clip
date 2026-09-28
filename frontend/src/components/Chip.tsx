import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

/** A small pill action: Rewrite, Copy, in −1s, Reset to auto. */
export function Chip({
  className,
  type = 'button',
  onDark = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { onDark?: boolean }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-full border-[1.5px] text-[11.5px] font-medium whitespace-nowrap cursor-pointer transition-colors',
        onDark
          ? 'border-white/30 text-white/75 hover:border-white/55 hover:text-white'
          : 'border-ink/40 text-ink-soft hover:bg-cream',
        className,
      )}
      {...rest}
    />
  )
}
