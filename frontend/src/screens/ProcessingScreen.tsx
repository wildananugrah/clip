import { Button } from '../components/Button'
import { Meter } from '../components/Meter'
import { CLIPS } from '../data/fixtures'
import { cn } from '../lib/cn'
import { fmt } from '../lib/format'
import { useApp } from '../state/AppContext'

const STEPS = ['Downloaded source', 'Transcribed', 'Scoring moments & rendering', 'Subtitles']

/** Each step owns a quarter of the run. */
const STEP_SHARE = 24

export function ProcessingScreen() {
  const { state, cancelJob, goResults } = useApp()
  const ready = Math.floor((state.progress / 100) * state.count)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-[34px] sm:px-10">
      <div className="mb-[26px] max-w-[620px]">
        <h1 className="m-0 mb-2 font-display text-[30px] leading-[1.15] font-bold tracking-[-0.025em] text-ink">
          Finding the good bits.
        </h1>
        <p className="m-0 text-[13.5px] leading-[1.6] text-muted">
          {state.jobDone
            ? `All done. ${state.count} clips ready to review.`
            : `You can close this tab — we’ll email you when it’s done. ${ready} of ${state.count} clips ready.`}
        </p>
      </div>

      <Meter
        value={`${state.progress}%`}
        tone="violet"
        className="mb-5 h-1.5 max-w-[620px] rounded-[3px]"
      />

      <ol className="m-0 mb-7 flex list-none flex-wrap gap-6 p-0">
        {STEPS.map((label, i) => {
          const done = state.progress > (i + 1) * STEP_SHARE
          const active = !done && state.progress > i * STEP_SHARE
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className={cn(
                  'size-4 flex-none rounded-full border-2',
                  done
                    ? 'border-ink bg-ink'
                    : active
                      ? 'border-violet bg-transparent'
                      : 'border-black/14 bg-transparent',
                )}
              />
              <span
                className={cn(
                  'text-[12.5px] font-medium',
                  done || active ? 'text-ink' : 'text-black/35',
                )}
              >
                {label}
              </span>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap gap-3.5">
        {Array.from({ length: state.count }, (_, i) => {
          const isReady = i < ready
          const rendering = i === ready && !state.jobDone
          // Prototype durations only stretch to CLIPS.length; a job may ask for more.
          const seed = CLIPS[i]
          return (
            <div key={i} className="w-32 flex-none">
              <div
                className={cn(
                  'flex items-end rounded-2xl border border-black/10 p-[9px]',
                  isReady ? 'hatch-sand' : 'border-dashed bg-[#F1EEE8]',
                )}
                style={{ aspectRatio: '9/16' }}
              >
                {isReady && seed && (
                  <span className="rounded-[4px] bg-black/60 px-[5px] py-0.5 text-[10.5px] font-medium text-white">
                    {fmt(seed.e - seed.s)}
                  </span>
                )}
              </div>
              <div
                className={cn(
                  'mt-[7px] text-[11.5px] font-medium',
                  isReady ? 'text-ink-soft' : 'text-black/35',
                )}
              >
                {isReady ? `Clip ${i + 1} ready` : rendering ? 'Rendering…' : 'Queued'}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-4 pt-6">
        <Button
          variant="outline"
          onClick={() => cancelJob()}
          loading={state.pending === 'cancelJob'}
          className="h-10 px-[18px] text-[13px]"
        >
          {state.pending === 'cancelJob' ? 'Cancelling…' : 'Cancel job'}
        </Button>
        {state.jobDone && (
          <Button onClick={goResults} className="h-10 px-5 text-[13px]">
            See all clips
          </Button>
        )}
        <span className="text-[12px] text-black/40">
          Cancelling keeps what’s finished and refunds your free video.
        </span>
      </div>
    </div>
  )
}
