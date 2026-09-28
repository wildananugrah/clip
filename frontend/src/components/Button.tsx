import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

type Variant = 'primary' | 'outline' | 'quiet' | 'onDark'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  /**
   * Primary buttons sit in a sand resting state until the action is actually
   * available, then fill with violet. Ignored by the other variants.
   */
  armed?: boolean
  /**
   * The action behind this button is in flight: shows a spinner and stops
   * further clicks.
   *
   * Disabling is the point as much as the spinner is. "Get clips" and "Download
   * & make N clips" used to stay live through their whole round trip, so a
   * double-click ran the analysis twice or created two jobs -- and jobs are
   * quota'd, so that cost the user one of three for the day.
   */
  loading?: boolean
}

const base =
  'inline-flex items-center justify-center rounded-full border-[1.5px] font-sans whitespace-nowrap cursor-pointer transition-colors disabled:cursor-not-allowed'

const variants: Record<Variant, string> = {
  primary: 'border-ink shadow-stamp font-semibold',
  outline: 'border-ink bg-paper font-medium text-ink-soft hover:bg-cream',
  quiet: 'border-ink/50 bg-paper font-medium text-ink-soft hover:bg-cream',
  onDark:
    'border-white/35 bg-transparent font-medium text-white/85 hover:border-white/60 hover:text-white',
}

export function Button({
  variant = 'primary',
  armed = true,
  loading = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      // A spinner alone leaves the control clickable, which is how duplicate
      // jobs got created. Loading implies disabled.
      disabled={disabled || loading}
      // Announces the wait to a screen reader, which cannot see the spinner.
      aria-busy={loading || undefined}
      className={cn(
        base,
        variants[variant],
        variant === 'primary' &&
          (armed
            ? 'bg-violet text-on-violet hover:bg-violet-deep'
            : 'bg-sand-deep text-ink/90'),
        // Only dim for a plain disabled state: a loading button already reads as
        // busy from the spinner, and fading it too makes the label hard to read.
        disabled && !loading && 'opacity-55',
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
}

/**
 * A ring that spins in the button's own text colour, so it works on every
 * variant including onDark. Tailwind's animate-spin needs no extra CSS.
 */
function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="mr-2 block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}
