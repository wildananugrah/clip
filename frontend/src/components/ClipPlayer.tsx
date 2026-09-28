import { useEffect, useRef, useState } from 'react'
import { fmt } from '../lib/format'
import { MediaSpinner } from './MediaSpinner'
import type { Clip, Ratio } from '../types'

/**
 * Watch one rendered clip, over the grid.
 *
 * An overlay rather than a screen: the editor already owns "open one clip" as a
 * full screen, but that is the prototype timeline, and watching a finished
 * render should not cost you your place in the results grid.
 *
 * Props, not context, so it renders to static markup in a test without a
 * provider -- the same reason JobIndicator takes props.
 */
export function ClipPlayer({
  clip,
  ratio,
  onClose,
}: {
  clip: Clip | null
  ratio: Ratio
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  /**
   * Which URL has its first frame, and which failed. Per URL rather than a
   * boolean, because this overlay stays mounted from clip to clip: a boolean
   * left true by the last clip would skip the spinner on the next.
   */
  const [ready, setReady] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** Playback stalled to buffer -- the same black box, so the same spinner. */
  const [stalled, setStalled] = useState(false)

  // Escape closes, matching the editor screen's keyboard contract.
  useEffect(() => {
    if (!clip) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [clip, onClose])

  // Move focus into the overlay so the keyboard is not left behind the backdrop.
  useEffect(() => {
    if (clip) closeRef.current?.focus()
  }, [clip])

  if (!clip) return null

  const url = clip.renders[ratio]?.url ?? null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${clip.t}`}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/78 p-6"
      // A click on the backdrop itself closes; clicks inside must not bubble out.
      onClick={onClose}
    >
      <div
        className="flex max-h-full min-h-0 flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          /*
            The size lives on this wrapper and the video fills it, so the
            spinner (inset-0 of the wrapper) always covers exactly the video.
            With the height on the video instead, a short screen shrank the
            wrapper and left the overlay covering only the top of the picture.
            The render's own shape from the start, too: a bare video is a
            300x150 box until its first frame, then jumps.
          */
          <div
            className="relative min-h-0 max-w-full"
            style={{ height: '72vh', aspectRatio: ratio.replace(':', '/') }}
          >
            <video
              src={url}
              controls
              autoPlay
              playsInline
              onLoadedData={() => {
                setReady(url)
                setStalled(false)
              }}
              onWaiting={() => setStalled(true)}
              onPlaying={() => setStalled(false)}
              onError={() => setFailed(url)}
              className="block size-full rounded-[14px] bg-black shadow-2xl"
            />
            {failed === url ? (
              <span
                role="alert"
                className="absolute inset-0 flex items-center justify-center rounded-[14px] bg-black/70 px-6 text-center text-[13px] text-white/85"
              >
                This clip would not load. Close the player and try again.
              </span>
            ) : (
              (ready !== url || stalled) && (
                <span className="absolute inset-0 overflow-hidden rounded-[14px]">
                  <MediaSpinner label={ready === url ? 'Buffering…' : 'Loading video…'} />
                </span>
              )
            )}
          </div>
        ) : (
          <div className="rounded-[14px] bg-paper px-6 py-8 text-[13px] text-muted">
            That format is not ready for this clip yet.
          </div>
        )}

        <div className="max-w-[560px] text-center">
          <div className="text-[13.5px] font-semibold text-white">{clip.t}</div>
          <div className="mt-0.5 text-[11.5px] text-white/60">
            {fmt(clip.e - clip.s)} · {ratio}
          </div>
        </div>
      </div>

      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close player"
        className="absolute top-3 right-3 flex size-11 cursor-pointer items-center justify-center rounded-full text-[22px] leading-none text-white/75 hover:bg-white/10 hover:text-white md:top-4 md:right-5"
      >
        ×
      </button>
    </div>
  )
}
