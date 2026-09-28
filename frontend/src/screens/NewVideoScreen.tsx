import { Button } from '../components/Button'
import { useApp } from '../state/AppContext'

export function NewVideoScreen() {
  const { state, setUrl, analyze, loadSample } = useApp()
  const busy = state.pending === 'analyze'
  // Armed on a non-empty URL; the button still disables itself while analysing,
  // which is what stops a second submit resolving the same link twice.
  const armed = state.url.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto px-6 py-8 text-center sm:px-10">
      <div className="mb-[22px] flex size-16 items-center justify-center rounded-2xl border-[1.5px] border-dashed border-ink/20">
        <span className="ml-1 block size-0 border-y-8 border-l-[13px] border-y-transparent border-l-ink" />
      </div>

      <h1 className="m-0 mb-2.5 font-display text-[34px] leading-[1.15] font-bold tracking-[-0.025em] text-ink">
        Paste a link to start.
      </h1>
      <p className="m-0 mb-[26px] max-w-[420px] text-[14px] leading-[1.6] text-muted">
        Works with YouTube, Twitch VODs, Kick and most direct video links. A 2-hour stream takes
        about 6 minutes.
      </p>

      <form
        className="flex w-full max-w-[560px] flex-col gap-2.5 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          analyze()
        }}
      >
        <label htmlFor="source-url" className="sr-only">
          Video URL
        </label>
        <input
          id="source-url"
          value={state.url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a video URL"
          /*
            Taller on a phone than on a desktop: stacked above the button it
            spans the full width, and at the desktop height that reads as a
            thin strip rather than a field worth tapping.
          */
          className="h-[72px] flex-1 rounded-full border-2 border-ink bg-paper px-[20px] text-[14px] text-ink outline-none focus:border-violet sm:h-[60px]"
        />
        <Button
          type="submit"
          armed={armed}
          loading={busy}
          className="h-[60px] px-7 text-[14px]"
        >
          {busy ? 'Reading the link…' : 'Get clips'}
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="text-[12px] text-ink/40">or try a sample:</span>
        <button
          type="button"
          onClick={() => loadSample('podcast')}
          className="cursor-pointer border-b border-violet/30 text-[12px] font-medium text-violet"
        >
          45-min podcast
        </button>
        <button
          type="button"
          onClick={() => loadSample('stream')}
          className="cursor-pointer border-b border-violet/30 text-[12px] font-medium text-violet"
        >
          2-hr stream VOD
        </button>
      </div>
    </div>
  )
}
