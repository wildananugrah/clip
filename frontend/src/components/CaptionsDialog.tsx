import { useEffect, useRef } from 'react'
import { Button } from './Button'
import { Chip } from './Chip'
import { hashtagLine, postText } from '../lib/social'
import type { SocialCopy } from '../types'

export interface CaptionsDialogProps {
  /** The clip's headline, so the user can tell which clip this is for. */
  title: string
  /**
   * `loading` covers both the first set and a regenerate; which one it is shows
   * in whether `social` is already there.
   */
  phase: 'loading' | 'ready' | 'error'
  social: SocialCopy | null
  error: string | null
  /**
   * The ready-to-paste source credit, or null when the source is not known yet.
   * Independent of `social`: it is read off the video, not written by the model.
   */
  credit: string | null
  /** Copy `text`; `what` names it for the confirmation ("Caption copied."). */
  onCopy: (text: string, what: string) => void
  onRegenerate: () => void
  onClose: () => void
}

const HEADING = 'm-0 mb-2 text-[10.5px] font-semibold tracking-[.07em] text-ink/45 uppercase'

/**
 * Caption options, the source credit, and hashtags for posting one clip.
 *
 * Props, not context, for the reason ClipPlayer gives: every state renders to
 * static markup in a test. ClipCaptions owns the fetching.
 */
export function CaptionsDialog({
  title,
  phase,
  social,
  error,
  credit,
  onCopy,
  onRegenerate,
  onClose,
}: CaptionsDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const loading = phase === 'loading'

  // Escape closes, matching the player's keyboard contract.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Move focus into the overlay so the keyboard is not left behind the backdrop.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Captions for ${title}`}
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 sm:items-center sm:p-6"
      // A click on the backdrop itself closes; clicks inside must not bubble out.
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full flex-col rounded-t-[18px] bg-paper shadow-2xl sm:max-w-[480px] sm:rounded-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-none items-start gap-3 border-b border-ink/8 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[15px] font-semibold text-ink">Captions &amp; hashtags</h2>
            <p className="m-0 mt-0.5 truncate text-[12px] text-ink/45">{title}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close captions"
            className="-mt-1 -mr-2 flex size-10 flex-none cursor-pointer items-center justify-center rounded-full text-[22px] leading-none text-ink/50 hover:bg-cream hover:text-ink"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4" aria-busy={loading || undefined}>
          {phase === 'error' && (
            <p
              role="alert"
              className="m-0 mb-4 rounded-[10px] bg-cream px-3.5 py-3 text-[12.5px] text-ink-soft"
            >
              {error ?? 'Could not write captions.'}
            </p>
          )}

          {!social && loading && (
            <div role="status" className="flex flex-col items-center gap-2.5 py-10 text-[12.5px] text-muted">
              <span className="size-7 rounded-full border-[3px] border-ink/15 border-t-violet motion-safe:animate-spin" />
              Writing captions for this clip…
            </div>
          )}

          {social && (
            <>
              <h3 className={HEADING}>Captions</h3>
              <ol className="m-0 mb-5 flex list-none flex-col gap-2 p-0">
                {social.captions.map((caption, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2.5 rounded-[10px] border border-ink/10 p-3"
                  >
                    <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-ink">{caption}</p>
                    <Chip
                      onClick={() => onCopy(caption, 'Caption')}
                      aria-label={`Copy caption ${i + 1}`}
                      className="h-[30px] flex-none px-[11px]"
                    >
                      Copy
                    </Chip>
                  </li>
                ))}
              </ol>
            </>
          )}

          {credit && (
            <>
              <h3 className={HEADING}>Source</h3>
              <div className="mb-5 flex items-start gap-2.5 rounded-[10px] border border-ink/10 p-3">
                <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] whitespace-pre-line text-ink [overflow-wrap:anywhere]">
                  {credit}
                </p>
                <Chip
                  onClick={() => onCopy(credit, 'Source')}
                  aria-label="Copy source"
                  className="h-[30px] flex-none px-[11px]"
                >
                  Copy
                </Chip>
              </div>
            </>
          )}

          {social && social.hashtags.length > 0 && (
            <>
              <h3 className={HEADING}>Hashtags</h3>
              <ul className="m-0 mb-3 flex list-none flex-wrap gap-1.5 p-0">
                {social.hashtags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full bg-sand px-2.5 py-1 text-[12px] font-medium text-ink-soft"
                  >
                    #{tag}
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* With neither tags nor a credit, the full post would just be caption 1. */}
          {social && (social.hashtags.length > 0 || credit) && (
            <div className="flex flex-wrap gap-2">
              {social.hashtags.length > 0 && (
                <Chip
                  onClick={() => onCopy(hashtagLine(social.hashtags), 'Hashtags')}
                  className="h-[30px] px-[11px]"
                >
                  Copy hashtags
                </Chip>
              )}
              {/* The first caption is the one most people take, so it leads the post. */}
              <Chip
                onClick={() =>
                  onCopy(postText(social.captions[0], social.hashtags, credit ?? ''), 'Post')
                }
                className="h-[30px] px-[11px]"
              >
                Copy full post
              </Chip>
            </div>
          )}
        </div>

        <div className="flex flex-none items-center justify-end gap-2 border-t border-ink/8 px-5 py-3">
          {/*
            Regenerate keeps the current set on screen while the new one is
            written, so a caption can still be copied if the wait runs long.
          */}
          <Button
            variant="quiet"
            onClick={onRegenerate}
            loading={loading}
            className="h-9 px-4 text-[12.5px]"
          >
            {loading ? 'Writing…' : phase === 'error' && !social ? 'Try again' : 'Regenerate'}
          </Button>
        </div>
      </div>
    </div>
  )
}
