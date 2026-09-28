import { Button } from './Button'
import { Logo } from './Logo'

/**
 * Shown instead of the editor below the `md` breakpoint.
 *
 * The reason is layout, not readiness: the editor's header alone packs ~487px
 * of non-shrinking, nowrap controls, so on a 335px viewport it clips its own
 * save button off-screen with no way to reach it, and an 11px trim handle is
 * not a touch target. Rather than ship that, say plainly it needs a wider
 * screen.
 *
 * It renders outside AppShell, like the editor it replaces, so it carries its
 * own way back; there is no nav chrome here to fall back on.
 */
export function EditorUnavailable({
  clipTitle,
  onBack,
}: {
  clipTitle?: string
  onBack: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-cream px-6 py-10 text-center">
      <Logo size="sm" />
      <h1 className="m-0 max-w-[340px] font-display text-[21px] leading-[1.2] font-bold tracking-[-0.02em] text-ink">
        Editing needs a bigger screen
      </h1>
      <p className="m-0 max-w-[340px] text-[13px] leading-[1.6] text-muted">
        {clipTitle ? (
          <>
            Trimming <span className="font-medium text-ink-soft">“{clipTitle}”</span> needs a
            timeline wider than a phone. Open this project on a laptop to edit it.
          </>
        ) : (
          <>
            The clip editor needs a timeline wider than a phone. Open this project on a laptop to
            edit it.
          </>
        )}
      </p>
      <p className="m-0 max-w-[340px] text-[11.5px] text-ink/40">
        You can still watch, redo and download clips from here.
      </p>
      <Button onClick={onBack} className="mt-1 h-11 px-5 text-[13px]">
        Back to clips
      </Button>
    </div>
  )
}
