import { cn } from '../lib/cn'
import { setThemePref, useTheme } from '../lib/theme'

/**
 * One-click switch between light and dark. Picks an explicit theme, so going
 * back to "follow the device" is a Settings job (the Appearance card).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'

  return (
    <button
      type="button"
      onClick={() => setThemePref(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={cn(
        'flex size-9 flex-none cursor-pointer items-center justify-center rounded-full text-ink/45 transition-colors hover:bg-ink/[0.055] hover:text-ink',
        className,
      )}
    >
      {/* The icon shows where the click takes you, like the label says. */}
      {next === 'dark' ? (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-[17px]" aria-hidden="true">
          <path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7Z" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-[17px]" aria-hidden="true">
          <circle cx="10" cy="10" r="3.4" />
          <path
            d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )
}
