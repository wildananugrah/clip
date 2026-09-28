/**
 * Share one clip to TikTok, Reels, WhatsApp -- whatever the phone offers.
 *
 * Renders nothing where the browser cannot share a file (most desktops,
 * Firefox on Android). Those users have Download, and a Share button that could
 * only fall back to downloading would be the same button twice.
 *
 * Two taps on iOS, sometimes. See ShareOutcome in lib/share.ts: the file is
 * fetched on the first tap, and if that outlasts Safari's gesture window the
 * button keeps the file and asks for a second tap, which shares at once.
 */
import { useRef, useState } from 'react'
import { Chip } from './Chip'
import { cn } from '../lib/cn'
import { clipTitle } from '../lib/derive'
import { canShareFiles, clipFileName, shareFile } from '../lib/share'
import { useApp } from '../state/AppContext'
import type { Clip, Ratio } from '../types'

export function ShareClip({ clip, ratio }: { clip: Clip; ratio: Ratio }) {
  const { say } = useApp()
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready'>('idle')
  // Keyed by clip and ratio: switching the format tab must not share the file
  // that was fetched for the other one.
  const held = useRef<{ key: string; file: File } | null>(null)

  const render = clip.renders[ratio]
  if (!render?.url || render.status !== 'ready' || !canShareFiles()) return null
  const url = render.url
  const key = `${clip.id}:${ratio}`

  const onShare = async () => {
    if (phase === 'preparing') return

    if (held.current?.key !== key) {
      setPhase('preparing')
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
        if (!res.ok) throw new Error(String(res.status))
        const blob = await res.blob()
        held.current = {
          key,
          file: new File([blob], clipFileName(clip.idx, clip.t), { type: 'video/mp4' }),
        }
      } catch {
        // Most likely an expired signed URL on a tab left open for hours; the
        // grid's own thumbnails would be failing by then too.
        setPhase('idle')
        say('Could not fetch that clip. Refresh the page and try again.')
        return
      }
    }

    try {
      const outcome = await shareFile(navigator, held.current!.file, clipTitle(clip))
      setPhase(outcome === 'needs-tap' ? 'ready' : 'idle')
    } catch {
      setPhase('idle')
      say('This browser would not share the clip. Use Download instead.')
    }
  }

  return (
    <Chip
      onClick={() => void onShare()}
      aria-busy={phase === 'preparing' || undefined}
      className={cn(
        'h-10 flex-1 md:h-[30px]',
        phase === 'ready' && 'border-ink bg-ink text-on-ink hover:bg-ink',
        phase === 'preparing' && 'text-ink/30',
      )}
    >
      {phase === 'preparing' ? '…' : phase === 'ready' ? 'Tap to share' : 'Share'}
    </Chip>
  )
}
