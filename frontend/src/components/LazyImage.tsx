/**
 * An image that shows it is loading.
 *
 * Three states, each looking different, because they mean different things:
 *   loading -- a pulsing block, so an empty box reads as "coming", not "nothing"
 *   loaded  -- the image, faded in rather than popping over the placeholder
 *   failed  -- `fallbackClassName` (the app's hatch patterns), the same look a
 *              card has when there was never an image to load
 *
 * The wrapper carries the size, shape and any opacity; the image fills it and
 * owns only its fade-in. Callers size the wrapper as they sized the bare <img>
 * before, via className/style.
 *
 * `loading="lazy"` throughout: a projects list or a 24-clip grid should not pull
 * every thumbnail before the first one is on screen. It costs nothing for images
 * already in view, which load at once.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

type ImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'className' | 'style' | 'src' | 'onLoad' | 'onError'>

export function LazyImage({
  src,
  className,
  style,
  fallbackClassName,
  alt = '',
  ...img
}: ImgProps & {
  src: string
  /** Size and shape of the box. */
  className?: string
  style?: CSSProperties
  /** What the box shows if the image fails. Omit to show what is underneath. */
  fallbackClassName?: string
}) {
  // Settled per src, so a new src starts loading again instead of inheriting
  // the last one's "loaded" -- which would show a blank box with no pulse.
  const [settled, setSettled] = useState<{ src: string; ok: boolean } | null>(null)
  const status = settled?.src !== src ? 'loading' : settled.ok ? 'loaded' : 'failed'
  const ref = useRef<HTMLImageElement | null>(null)

  /**
   * An image already in the browser cache can finish before React attaches
   * onLoad, and then no load event ever reaches it: the pulse would run
   * forever over a picture that is right there. Checked before paint, so a
   * cached thumbnail never flashes the placeholder at all.
   */
  useLayoutEffect(() => {
    const el = ref.current
    if (el?.complete && el.naturalWidth > 0) setSettled({ src, ok: true })
  }, [src])

  return (
    <span
      className={cn(
        // No `position` here, deliberately. Callers pass `absolute inset-0` to
        // lay the image behind a card's overlays, and cn() only joins classes --
        // it does not resolve conflicts -- so a `relative` here beat the caller's
        // `absolute` and dropped the image into the card's flow, pushing the
        // hook badge and checkbox below it. The image is in normal flow inside
        // this box, so the box never needed to be positioned.
        'block overflow-hidden',
        status === 'loading' && 'bg-ink/[0.07] motion-safe:animate-pulse',
        status === 'failed' && fallbackClassName,
        className,
      )}
      style={style}
      aria-busy={status === 'loading' || undefined}
    >
      {status !== 'failed' && (
        <img
          ref={ref}
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setSettled({ src, ok: true })}
          onError={() => setSettled({ src, ok: false })}
          className={cn(
            'size-full object-cover transition-opacity duration-300',
            status === 'loaded' ? 'opacity-100' : 'opacity-0',
          )}
          {...img}
        />
      )}
    </span>
  )
}
