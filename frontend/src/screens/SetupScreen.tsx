import { useState } from 'react'
import { Button } from '../components/Button'
import { LazyImage } from '../components/LazyImage'
import { OptionChip } from '../components/OptionChip'
import { Toggle } from '../components/Toggle'
import {
  CLIP_COUNTS,
  CLIP_COUNT_MAX,
  CLIP_COUNT_MIN,
  COUNT_HINTS,
  LENGTHS,
  RATIOS,
} from '../data/fixtures'
import { MAX_PROMPT_CHARS as PROMPT_MAX } from '../../../shared/types'
import { cn } from '../lib/cn'
import { clampClipCount, etaForCount, quota } from '../lib/derive'
import { useApp } from '../state/AppContext'

export function SetupScreen() {
  const { state, setCount, setLengthIdx, setPrompt, toggleFormat, toggleSubs, startJob, goNew } =
    useApp()
  const src = state.source

  /**
   * Whether the custom box is showing. Local, not app state: it is a view mode,
   * not something worth persisting. Seeded from the count itself so a saved
   * custom value like 17 reopens the box after a reload instead of silently
   * looking like no preset is selected.
   */
  const [customOpen, setCustomOpen] = useState(() => !CLIP_COUNTS.includes(state.count))
  /**
   * The box keeps its own draft so the field can be cleared and retyped. Writing
   * straight to state.count would clamp an empty box to 1 on the first keystroke
   * and fight the user.
   */
  const [draft, setDraft] = useState(String(state.count))

  const allowance = quota(state.quota)

  // Reachable by restoring a stale `screen` from storage without a source.
  if (!src) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-7">
        <button
          type="button"
          onClick={goNew}
          className="cursor-pointer text-[13.5px] font-medium text-violet hover:text-violet-deep"
        >
          No video selected — paste a link to start
        </button>
      </div>
    )
  }

  // items-start below md. Centring a card taller than the viewport pushes its
  // top above the scroll origin, where it is cropped and cannot be scrolled
  // back to -- the card is ~700px on a phone with ~560px to work with.
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-4 sm:p-7 md:items-center">
      <div className="animate-rise w-full max-w-[640px] overflow-hidden rounded-[22px] border-2 border-ink bg-white shadow-stamp-lg">
        <div className="flex gap-4 border-b border-black/8 p-5">
          {/*
            The video's own thumbnail, where there used to be only the hatch --
            the analyse call already returns it. The hatch stays for a source
            without one, and for one that fails to load.
          */}
          <div
            className="relative w-[150px] flex-none overflow-hidden rounded-[8px]"
            style={{ aspectRatio: '16/9' }}
          >
            {src.thumbnailUrl ? (
              <LazyImage
                src={src.thumbnailUrl}
                fallbackClassName="hatch-sand"
                className="absolute inset-0"
              />
            ) : (
              <div className="hatch-sand absolute inset-0" />
            )}
            <span className="absolute right-[7px] bottom-[7px] rounded-[4px] bg-black/60 px-[5px] py-0.5 text-[10.5px] font-medium text-white">
              {src.length}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-[7px]">
              <span className="rounded-[5px] bg-violet/9 px-[7px] py-[3px] text-[10.5px] font-medium tracking-[.05em] text-violet uppercase">
                {src.platform}
              </span>
              <span className="text-[11.5px] text-black/40">Link recognised</span>
            </div>
            <h2 className="m-0 mb-[5px] text-[15px] leading-[1.35] font-semibold text-ink">
              {src.title}
            </h2>
            <p className="m-0 text-[12.5px] text-black/45">{src.meta}</p>
          </div>
        </div>

        <div className="flex flex-col gap-5 px-5 py-[22px]">
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
              How many clips?
            </legend>
            <div className="flex gap-2">
              {CLIP_COUNTS.map((n, i) => {
                const selected = state.count === n
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setCount(n)
                      setCustomOpen(false)
                    }}
                    className={cn(
                      'flex h-[60px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[9px] border-[1.5px] transition-colors',
                      selected ? 'border-violet bg-violet/5' : 'border-black/14 bg-white hover:bg-cream',
                    )}
                  >
                    <span className="text-[15px] font-semibold text-ink">{n}</span>
                    <span
                      className={cn('text-[11px]', selected ? 'text-violet' : 'text-black/45')}
                    >
                      {COUNT_HINTS[i]}
                    </span>
                  </button>
                )
              })}

              <button
                type="button"
                aria-pressed={customOpen}
                onClick={() => {
                  setCustomOpen(true)
                  setDraft(String(state.count))
                }}
                className={cn(
                  'flex h-[60px] flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[9px] border-[1.5px] transition-colors',
                  customOpen
                    ? 'border-violet bg-violet/5'
                    : 'border-black/14 bg-white hover:bg-cream',
                )}
              >
                <span className="text-[15px] font-semibold text-ink">
                  {customOpen ? state.count : '…'}
                </span>
                <span className={cn('text-[11px]', customOpen ? 'text-violet' : 'text-black/45')}>
                  custom
                </span>
              </button>
            </div>

            {customOpen && (
              <div className="mt-2.5 flex items-center gap-2.5">
                <label htmlFor="clip-count" className="text-[12px] text-black/55">
                  Number of clips
                </label>
                <input
                  id="clip-count"
                  type="number"
                  inputMode="numeric"
                  min={CLIP_COUNT_MIN}
                  max={CLIP_COUNT_MAX}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    // Only commit a value that is already in range, so typing
                    // through an intermediate state does not snap the number.
                    const n = Number(e.target.value)
                    if (
                      Number.isInteger(n) &&
                      n >= CLIP_COUNT_MIN &&
                      n <= CLIP_COUNT_MAX
                    ) {
                      setCount(n)
                    }
                  }}
                  onBlur={() => {
                    // Leaving the field settles whatever is in it.
                    const n = clampClipCount(draft)
                    setDraft(String(n))
                    setCount(n)
                  }}
                  className="h-9 w-[84px] rounded-[8px] border-[1.5px] border-ink px-2.5 text-[13px] text-ink outline-none focus:border-violet"
                />
                <span className="text-[11.5px] text-black/42">
                  {CLIP_COUNT_MIN}–{CLIP_COUNT_MAX}
                </span>
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[18px]">
            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
                Clip length
              </legend>
              <div className="flex gap-1.5">
                {LENGTHS.map((label, i) => (
                  <OptionChip
                    key={label}
                    selected={state.lengthIdx === i}
                    onClick={() => setLengthIdx(i)}
                    className="h-9 rounded-[8px]"
                  >
                    {label}
                  </OptionChip>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 border-0 p-0">
              <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
                Formats to render
              </legend>
              <div className="flex gap-1.5">
                {RATIOS.map((label) => (
                  <OptionChip
                    key={label}
                    selected={state.formats[label]}
                    onClick={() => toggleFormat(label)}
                    className="h-9 rounded-[8px]"
                  >
                    {label}
                  </OptionChip>
                ))}
              </div>
            </fieldset>
          </div>

          <button
            type="button"
            onClick={toggleSubs}
            className="flex cursor-pointer items-center gap-2.5 rounded-[9px] bg-cream px-3.5 py-3 text-left"
          >
            <Toggle on={state.subs} label="Burn in subtitles" />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">Burn in subtitles</span>
              <span className="block text-[11.5px] text-black/45">
                Auto-transcribed, editable per clip later
              </span>
            </span>
          </button>

          {/*
            Free text sits last, after the chips. The chips are a few taps and
            most runs never touch this; leading with a blank box would make the
            quick path look like it needs filling in first.
          */}
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-[9px] p-0 text-[12.5px] font-medium text-ink">
              What should the clips be about?{' '}
              <span className="font-normal text-black/42">optional</span>
            </legend>
            <textarea
              id="clip-prompt"
              value={state.prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={PROMPT_MAX}
              rows={3}
              placeholder="e.g. only the parts where he talks about his first startup failing"
              className="w-full resize-y rounded-[9px] border-[1.5px] border-black/14 bg-white px-3 py-2.5 text-[13px] leading-[1.5] text-ink outline-none placeholder:text-black/30 focus:border-violet"
            />
            <div className="mt-1.5 flex items-start justify-between gap-3">
              <span className="text-[11.5px] text-black/45">
                Steers which moments get picked. Leave empty to find the strongest
                hooks anywhere in the video.
              </span>
              {/*
                Only once it is close enough to matter. A counter sitting at
                0/500 under an empty box reads as a quota to fill.
              */}
              {state.prompt.length > PROMPT_MAX * 0.8 && (
                <span className="shrink-0 text-[11.5px] tabular-nums text-black/42">
                  {state.prompt.length}/{PROMPT_MAX}
                </span>
              )}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3.5">
            <Button
              onClick={startJob}
              loading={state.pending === 'startJob'}
              className="h-[46px] min-w-[220px] flex-1 text-[14px]"
            >
              {state.pending === 'startJob'
                ? 'Queueing…'
                : `Download & make ${state.count} clips`}
            </Button>
            {/*
              Both halves of this line used to lie: the ETA came from the server
              computed at a fixed 12 clips, and "uses 1 of 3" was hardcoded text
              that ignored the real allowance.
            */}
            <span className="text-[12px] whitespace-nowrap text-black/42">
              {etaForCount(src.durationSeconds, state.count)}
              {allowance.known &&
                (allowance.exhausted
                  ? ' · no videos left this month'
                  : ` · uses 1 of ${allowance.remaining} left`)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
