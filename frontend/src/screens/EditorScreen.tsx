import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { EditorUnavailable } from '../components/EditorUnavailable'
import { JobIndicator } from '../components/JobIndicator'
import { LazyImage } from '../components/LazyImage'
import { MediaSpinner } from '../components/MediaSpinner'
import { TrimHandle } from '../components/TrimHandle'
import { FEATURES } from '../config'
import { RATIOS, TIMELINE_SPAN, WAVE } from '../data/fixtures'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { clipTitle, jobIndicator } from '../lib/derive'
import { fmt } from '../lib/format'
import { useIsDesktop } from '../lib/media'
import { useApp } from '../state/AppContext'
import { manualWindow, overviewPeaks, windowPeaks } from '../lib/manual'
import { pctOf, previewFor, videoTimeFor, windowFor } from '../state/useSnipline'
import type { Clip, Ratio, TranscriptLine } from '../types'

/** Box sizes for the crop buttons, in the same order as RATIOS. */
const CROP_BOX: Record<Ratio, string> = {
  '9:16': 'w-[52px] h-[92px]',
  '1:1': 'w-[52px] h-[52px]',
  '4:5': 'w-[52px] h-[65px]',
}

/**
 * A job in one of these is finished with: nothing resumes it without an
 * explicit regenerate. Mirrors TERMINAL_STATUSES in shared/types.ts -- the
 * frontend deliberately does not import across the workspace.
 */
const TERMINAL: string[] = ['completed', 'failed', 'cancelled']

const FILMSTRIP_FRAMES = 16
const TICKS = 6
/** Seconds each nudge moves an in/out point. */
const NUDGE_SECONDS = 1

export function EditorScreen() {
  const isDesktop = useIsDesktop()
  const {
    state,
    trackRef,
    say,
    backToResults,
    saveTrim,
    setRatio,
    setTrim,
    beginDrag,
    pickRange,
    resetTrim,
    redoClip,
    preparePreview,
    prepareSource,
    setManualStart,
    refreshJob,
    go,
  } = useApp()

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  /**
   * The preview URL whose metadata has arrived. Metadata, not the first frame:
   * this video is preload="metadata" and waits for Play, so "loaded data" would
   * never come and the spinner would never leave. Per URL, because a backfill
   * swaps the render for the proxy under the same element.
   */
  const [videoReady, setVideoReady] = useState<string | null>(null)
  const [videoStalled, setVideoStalled] = useState(false)
  /** Position on the visible timeline, 0-100. Driven by the video's own clock. */
  const [playhead, setPlayhead] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null)
  /** True while the server is building this project's missing proxies. */
  const [preparing, setPreparing] = useState(false)
  /** True while the server is building the full-length source assets. */
  const [preparingSource, setPreparingSource] = useState(false)

  const clip: Clip | undefined = state.clips.find((c) => c.id === state.editing)

  /**
   * Manual mode moves this window; it does not replace the editor. Everything
   * below -- handles, nudges, transcript clicks, the save -- already works on
   * an arbitrary 150-second span, and the server already accepts any range in
   * the video, so unpinning the window is the whole feature.
   */
  const source = state.source
  // Loose on purpose: `!== null` would read a MISSING field as manual mode,
  // turning it on for any state that simply never set it.
  const manual = state.manualStart != null
  const win = manual
    ? manualWindow(state.manualStart as number, source?.durationSeconds ?? 0)
    : windowFor(clip ?? { s: 0 })
  const inSec = win.start + (win.span * state.trimIn) / 100
  const outSec = win.start + (win.span * state.trimOut) / 100
  const nudgeStep = (NUDGE_SECONDS / win.span) * 100

  /**
   * In manual mode the full-length proxy IS the preview, and because it starts
   * at zero its file time is the source time -- videoTimeFor handles both with
   * no special case.
   */
  const preview =
    manual && source?.proxyUrl
      ? { url: source.proxyUrl, start: 0, span: source.durationSeconds, kind: 'proxy' as const }
      : clip
        ? previewFor(clip, state.ratio)
        : null

  /** A timeline percentage as an absolute offset into the source. */
  const sourceAt = useCallback((pct: number) => win.start + (pct / 100) * win.span, [win])

  const seek = useCallback(
    (pct: number) => {
      setPlayhead(pct)
      const video = videoRef.current
      // Clamped inside the preview: with the rendered clip as the source there
      // is no footage outside the cut, so the picture holds at the nearest
      // frame it has rather than the seek being rejected.
      if (video && preview) video.currentTime = videoTimeFor(preview, sourceAt(pct))
    },
    [preview, sourceAt],
  )

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      return
    }
    // Starting outside the trim would play material the export will not contain.
    if (playhead < state.trimIn || playhead >= state.trimOut) seek(state.trimIn)
    void video.play().catch(() => say('Could not start playback.'))
  }, [playhead, state.trimIn, state.trimOut, seek, say])

  /** Drop an in or out point where the playhead is sitting. */
  const markTrim = useCallback(
    (which: 'in' | 'out') => setTrim(which, playhead),
    [setTrim, playhead],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'i' || e.key === 'I') {
        markTrim('in')
      } else if (e.key === 'o' || e.key === 'O') {
        markTrim('out')
      } else if (e.key === 'Escape') {
        backToResults()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [backToResults, markTrim, togglePlay])

  /**
   * A clip with no proxy is playing its own rendered output, which cannot show
   * anything outside the cut. Ask the server to build the real thing, and swap
   * to it when it lands. Nothing blocks on this.
   */
  useEffect(() => {
    if (!clip || !state.jobId) return
    if (clip.proxyUrl) {
      // A backfill landed while this screen was open; the badge goes with it.
      setPreparing(false)
      return
    }
    let stopped = false
    setPreparing(true)
    void preparePreview(state.jobId, clip.id, () => stopped).finally(() => {
      if (!stopped) setPreparing(false)
    })
    return () => {
      stopped = true
    }
  }, [clip?.id, clip?.proxyUrl, state.jobId, preparePreview])

  /**
   * Keep the job fresh while it is unsettled.
   *
   * Opening a project from the grid fetches the job once and never subscribes,
   * so without this the banner would freeze at whatever it said on arrival --
   * and the save buttons would stay disabled after the job had actually
   * finished.
   */
  const jobUnsettled = !!state.jobStatus && !TERMINAL.includes(state.jobStatus)

  useEffect(() => {
    if (!jobUnsettled || !state.jobId) return
    const id = window.setInterval(() => void refreshJob(state.jobId), 5000)
    return () => window.clearInterval(id)
  }, [jobUnsettled, state.jobId, refreshJob])

  // The transcript covers the whole window, not just the cut: a line you cannot
  // see is a line you cannot trim to.
  useEffect(() => {
    if (!clip) return
    let cancelled = false
    void api
      .clipTranscript(clip.id)
      .then((r) => !cancelled && setTranscript(r.segments))
      .catch(() => !cancelled && setTranscript([]))
    return () => {
      cancelled = true
    }
  }, [clip?.id])

  /**
   * Below `md` the editor is replaced wholesale rather than reflowed.
   *
   * Its header alone packs ~487px of non-shrinking, nowrap controls into a
   * 335px viewport, which clips "Save & download" off-screen with no way to
   * reach it. Every hook above runs first, so this early return cannot change
   * hook order.
   */
  if (!isDesktop) {
    return <EditorUnavailable clipTitle={clip?.t} onBack={backToResults} />
  }

  // Reachable only if the clip vanished under us -- a delete in another tab, or
  // a reload that landed here before the job was re-fetched. The prototype fell
  // back to a fixture here, which quietly showed somebody a clip that was not
  // theirs and could not be saved.
  if (!clip) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-night px-6 text-center">
        <p className="m-0 text-[13px] text-white/60">That clip is no longer available.</p>
        <Button onClick={backToResults} className="h-10 px-5 text-[12.5px]">
          Back to clips
        </Button>
      </div>
    )
  }

  const duration = source?.durationSeconds ?? 0
  /**
   * Manual mode needs the full-length proxy, and a source shorter than one
   * window has nowhere to place it -- the pinned window already shows the lot.
   */
  const canGoManual = FEATURES.manualClip && duration > TIMELINE_SPAN

  const ratio = state.ratio as Ratio
  const busy = state.pending === 'saveClip'
  const recutting = !!state.regenerating[clip.id]

  /**
   * Saving is refused while the job is IN FLIGHT, because the pipeline rewrites
   * the clip list when it runs and would wipe a copy added underneath it. The
   * server applies the same rule, so the button and the route agree.
   *
   * Not 'completed': a cancelled or failed job is finished with, and the clips
   * it managed to render are as real as any other. Gating on 'completed' meant
   * a project cancelled after its clips had rendered opened here, played,
   * trimmed -- and then refused the save.
   *
   * A null status is the job not having loaded yet. Unknown is not finished.
   */
  const jobReady = !!state.jobStatus && TERMINAL.includes(state.jobStatus)
  const blockedReason = jobReady
    ? null
    : 'This project is still processing. Saving unlocks when it finishes.'

  /**
   * Build the full-length assets once manual mode is asked for.
   *
   * Lazily, and only here: a project nobody edits by hand never pays for the
   * re-download and the three encodes this costs.
   */
  useEffect(() => {
    if (!manual || source?.proxyUrl || !state.jobId) return
    let stopped = false
    setPreparingSource(true)
    void prepareSource(state.jobId, () => stopped).finally(() => {
      if (!stopped) setPreparingSource(false)
    })
    return () => {
      stopped = true
    }
  }, [manual, source?.proxyUrl, state.jobId, prepareSource])

  const playheadLeft = Math.max(state.trimIn, Math.min(state.trimOut, playhead))

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-night">
      {/*
        The editor renders outside AppShell, which is where JobIndicator
        normally lives -- so without this the screen refuses to save and shows
        nothing to explain it. Same derivation as the sidebar, so the two can
        never disagree about what is happening.
      */}
      {state.jobStatus !== 'completed' && (
        <JobIndicator
          indicator={jobIndicator(state)}
          variant="banner"
          onOpen={() => go('processing')}
        />
      )}

      <header className="flex h-[54px] flex-none items-center gap-3.5 border-b border-white/10 px-5">
        <button
          type="button"
          onClick={backToResults}
          className="flex-none cursor-pointer text-[12.5px] font-medium text-white/55 hover:text-white"
        >
          ← Back to clips
        </button>
        <h1 className="m-0 truncate text-[13.5px] font-semibold text-white">
          Clip · {clipTitle(clip)}
        </h1>
        {FEATURES.showHookScore && (
          <span className="flex-none rounded-[5px] bg-white/14 px-[7px] py-[3px] text-[10.5px] font-semibold whitespace-nowrap text-white">
            {clip.sc} hook
          </span>
        )}
        {blockedReason && (
          <span className="ml-auto flex-none text-[11.5px] text-white/50">{blockedReason}</span>
        )}
        <div className={cn('flex flex-none gap-2.5', !blockedReason && 'ml-auto')}>
          <Button
            variant="onDark"
            disabled={busy || recutting || !jobReady}
            onClick={() => void redoClip(clip.id)}
            className="h-9 px-[15px] text-[12.5px]"
          >
            {recutting ? 'Recutting…' : 'Regenerate this clip'}
          </Button>
          {canGoManual && (
            <Button
              variant="onDark"
              disabled={busy || recutting || !jobReady || preparingSource}
              onClick={() => {
                if (manual) return setManualStart(null)
                // Place it where the current window already is, so turning the
                // mode on does not move the picture out from under the user.
                setManualStart(win.start)
              }}
              className="h-9 px-[15px] text-[12.5px]"
            >
              {preparingSource
                ? 'Preparing…'
                : manual
                  ? 'Back to this clip'
                  : 'Clip anywhere'}
            </Button>
          )}
          <Button
            disabled={busy || recutting || !jobReady}
            onClick={() => void saveTrim(clip.id, inSec, outSec, ratio)}
            className="h-9 px-[18px] text-[12.5px]"
          >
            {busy ? 'Saving…' : 'Save as new clip'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-w-0 flex-1 items-center justify-center gap-[22px] p-[22px]">
          <div
            className={cn(
              'relative flex h-full max-h-[420px] flex-col justify-end overflow-hidden rounded-xl p-[18px]',
              preview ? 'bg-black' : 'hatch-night-lg border-2 border-dashed border-violet/55',
            )}
            style={{ aspectRatio: ratio.replace(':', '/') }}
          >
            {preview && (
              <video
                ref={videoRef}
                // Keyed on the URL: swapping the rendered clip for the proxy
                // when a backfill lands has to reload the element, not just
                // retarget a source it has already buffered.
                key={preview.url}
                src={preview.url}
                poster={clip.renders[ratio]?.thumbUrl ?? undefined}
                playsInline
                preload="metadata"
                // Cover, not contain: the box is the export's frame, so this is
                // the closest a centre crop gets to what the render will hold.
                className="absolute inset-0 size-full object-cover"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onLoadedMetadata={() => setVideoReady(preview.url)}
                onWaiting={() => setVideoStalled(true)}
                onPlaying={() => setVideoStalled(false)}
                onTimeUpdate={(e) => {
                  const video = e.currentTarget
                  const pct = pctOf(preview.start + video.currentTime, win)
                  // Loop the trim rather than the whole window: the point of the
                  // preview is the cut, and running past the out point shows
                  // material the export will not contain.
                  if (pct >= state.trimOut) {
                    video.currentTime = videoTimeFor(preview, sourceAt(state.trimIn))
                    setPlayhead(state.trimIn)
                    return
                  }
                  setPlayhead(pct)
                }}
              />
            )}
            {preview && (videoReady !== preview.url || videoStalled) && (
              <MediaSpinner label={videoReady === preview.url ? 'Buffering…' : 'Loading preview…'} />
            )}

            {playing && (
              <span className="absolute top-3.5 left-3.5 z-10 rounded-[5px] bg-violet/85 px-[7px] py-[3px] text-[10.5px] font-semibold text-white">
                playing
              </span>
            )}

            {preview?.kind === 'render' && (
              <span className="absolute top-3.5 right-3.5 z-10 rounded-[5px] bg-black/70 px-[7px] py-[3px] text-[10.5px] font-medium text-white/80">
                {preparing ? 'building full preview…' : 'showing the current cut'}
              </span>
            )}

            <p className="relative m-0 text-center text-[17px] leading-[1.25] font-bold whitespace-pre-line text-white [text-shadow:0_2px_6px_rgba(0,0,0,.6)]">
              {clip.line}
            </p>
          </div>

          <fieldset className="m-0 flex flex-none flex-col gap-2.5 border-0 p-0">
            <legend className="p-0 text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Crop
            </legend>
            {RATIOS.map((r) => {
              const on = ratio === r
              // A job renders only the formats it was started with, so the rest
              // would promise a file that does not exist.
              const rendered = !!clip.renders[r]
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  disabled={!rendered}
                  title={rendered ? undefined : `This project did not render ${r}.`}
                  onClick={() => setRatio(r)}
                  className={cn(
                    'flex items-center justify-center rounded-[7px] border-[1.5px] text-[11px] font-semibold transition-colors',
                    CROP_BOX[r],
                    !rendered && 'cursor-not-allowed border-white/10 text-white/25',
                    rendered && 'cursor-pointer',
                    rendered && on && 'border-violet bg-violet/16 text-white',
                    rendered &&
                      !on &&
                      'border-white/18 bg-transparent text-white/60 hover:border-white/40',
                  )}
                >
                  {r}
                </button>
              )
            })}
          </fieldset>
        </div>

        <aside className="flex w-full flex-none flex-col gap-[18px] overflow-auto border-white/10 bg-night-panel p-5 lg:w-[322px] lg:border-l">
          <section>
            <h2 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Transcript — click a line to trim to it
            </h2>
            <TranscriptPanel
              lines={transcript}
              win={win}
              trimIn={state.trimIn}
              trimOut={state.trimOut}
              onPick={(a, b) => {
                pickRange(a, b)
                seek(a)
              }}
            />
          </section>

          <section>
            <h2 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Caption for posting
            </h2>
            <p className="m-0 rounded-[8px] border border-white/14 p-[11px] text-[12.5px] leading-[1.55] text-white/80">
              {clip.cap}
            </p>
            <div className="mt-2 flex gap-2">
              <Chip
                onDark
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(clip.cap)
                    .then(() => say('Caption copied.'))
                    .catch(() => say('Could not reach the clipboard.'))
                }}
                className="h-[30px] px-[11px]"
              >
                Copy
              </Chip>
            </div>
          </section>

          <p className="m-0 mt-auto rounded-[8px] bg-white/5 p-[11px] text-[11.5px] leading-[1.55] text-white/50">
            Saving keeps this clip and adds the trimmed version to the project
            as a new one.
            <br />
            <span className="text-white/70">space</span> play ·{' '}
            <span className="text-white/70">i</span> /{' '}
            <span className="text-white/70">o</span> set in/out at the playhead ·{' '}
            <span className="text-white/70">esc</span> back
          </p>
        </aside>
      </div>

      <div className="flex h-[170px] flex-none flex-col gap-[11px] border-t border-white/10 px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-3.5">
          <button
            type="button"
            onClick={togglePlay}
            disabled={!preview}
            aria-label={playing ? 'Pause preview' : 'Play preview'}
            className="flex size-8 flex-none cursor-pointer items-center justify-center rounded-full bg-white text-[11px] text-night disabled:cursor-not-allowed disabled:opacity-40"
          >
            {playing ? '❚❚' : '▶'}
          </button>
          <span className="text-[13px] font-medium tabular-nums text-white">
            {fmt(inSec)} → {fmt(outSec)}
          </span>
          <span className="text-[12.5px] text-white/45">
            {(outSec - inSec).toFixed(1)}s selected
          </span>

          <div className="ml-2 flex gap-1.5">
            <Chip onDark onClick={() => setTrim('in', state.trimIn - nudgeStep)} className="h-7 px-[9px]">
              in −1s
            </Chip>
            <Chip onDark onClick={() => setTrim('in', state.trimIn + nudgeStep)} className="h-7 px-[9px]">
              in +1s
            </Chip>
            <Chip onDark onClick={() => setTrim('out', state.trimOut - nudgeStep)} className="h-7 px-[9px]">
              out −1s
            </Chip>
            <Chip onDark onClick={() => setTrim('out', state.trimOut + nudgeStep)} className="h-7 px-[9px]">
              out +1s
            </Chip>
          </div>

          <Chip onDark onClick={resetTrim} className="ml-auto h-7 px-[11px]">
            Reset to auto
          </Chip>
        </div>

        {manual && (
          /*
            The coarse half of the two-level timeline. Four hours across this
            track is ~13 seconds per pixel, which is why it only PLACES the
            window -- the trimming still happens below, at 150 seconds wide.
          */
          <div className="flex flex-none items-center gap-2.5">
            <span className="flex-none text-[10.5px] font-semibold tracking-[.07em] text-white/40 uppercase">
              Whole video
            </span>
            <div
              className="relative h-[34px] flex-1 cursor-pointer touch-none overflow-hidden rounded-[6px] bg-white/5"
              onPointerDown={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
                // Drop the window CENTRED on the click: the pointer marks the
                // moment wanted, not the start of a run-up to it.
                setManualStart(frac * duration - win.span / 2)
              }}
            >
              {source?.stripUrl && (
                <LazyImage
                  src={source.stripUrl}
                  draggable={false}
                  className="pointer-events-none size-full opacity-45"
                />
              )}
              <div className="pointer-events-none absolute right-0 bottom-0 left-0 flex h-3.5 items-end gap-px px-px opacity-60">
                {overviewPeaks(source?.peaks, 240).map((h, i) => (
                  <div key={i} className="flex-1 rounded-[1px] bg-muted" style={{ height: `${h}%` }} />
                ))}
              </div>
              {/* Where the detail timeline below is looking. */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 rounded-[4px] border-2 border-violet bg-violet/20"
                style={{
                  left: `${(win.start / duration) * 100}%`,
                  width: `${Math.max(0.6, (win.span / duration) * 100)}%`,
                }}
              />
            </div>
            <span className="flex-none text-[11px] tabular-nums text-white/45">
              {fmt(win.start)} → {fmt(win.start + win.span)}
            </span>
          </div>
        )}

        <div ref={trackRef} className="relative h-[84px] touch-none">
          {/*
            The scrub target sits UNDER the trim handles, so a pointer down on a
            handle starts a drag instead of jumping the playhead out from under
            the finger that grabbed it.
          */}
          <div
            className="absolute inset-0 flex cursor-pointer gap-px overflow-hidden rounded-[8px]"
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              seek(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)))
            }}
          >
            {manual ? (
              <div className="hatch-night size-full opacity-50" />
            ) : clip.stripUrl ? (
              <LazyImage
                src={clip.stripUrl}
                draggable={false}
                fallbackClassName="hatch-night"
                className="size-full opacity-60"
              />
            ) : (
              Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => (
                <div key={i} className="hatch-night flex-1 opacity-50" />
              ))
            )}
          </div>

          <div className="pointer-events-none absolute right-0 bottom-2 left-0 flex h-8 items-end gap-0.5 px-0.5 opacity-55">
            {(manual ? windowPeaks(source?.peaks, win) : (clip.peaks ?? WAVE)).map((h, i) => (
              <div key={i} className="flex-1 rounded-[1px] bg-muted" style={{ height: `${h}%` }} />
            ))}
          </div>

          <div
            className="pointer-events-none absolute top-0 bottom-0 left-0 rounded-l-[8px] bg-[rgba(26,25,23,.72)]"
            style={{ width: `${state.trimIn}%` }}
          />
          <div
            className="pointer-events-none absolute top-0 right-0 bottom-0 rounded-r-[8px] bg-[rgba(26,25,23,.72)]"
            style={{ width: `${100 - state.trimOut}%` }}
          />
          <div
            className="pointer-events-none absolute top-0 bottom-0 rounded-[8px] border-2 border-violet"
            style={{ left: `${state.trimIn}%`, right: `${100 - state.trimOut}%` }}
          />

          <TrimHandle
            which="in"
            value={state.trimIn}
            onPointerDown={beginDrag('in')}
            onNudge={(d) => setTrim('in', state.trimIn + d * nudgeStep)}
          />
          <TrimHandle
            which="out"
            value={state.trimOut}
            onPointerDown={beginDrag('out')}
            onNudge={(d) => setTrim('out', state.trimOut + d * nudgeStep)}
          />

          <div
            className="pointer-events-none absolute -top-1 -bottom-1 w-0.5 bg-white"
            style={{ left: `${playheadLeft}%` }}
          />
        </div>

        <div className="flex justify-between text-[10.5px] tabular-nums text-white/35">
          {Array.from({ length: TICKS }, (_, i) => (
            <span key={i}>{fmt(win.start + (win.span * i) / (TICKS - 1))}</span>
          ))}
        </div>

        {preview?.kind === 'render' && (
          <p className="m-0 text-[11px] text-white/40">
            {preparing
              ? 'Building a full preview for this project so you can scrub outside the cut. It downloads the source once, then every clip here gets one.'
              : 'Showing the finished clip, so the picture stops at the cut. Scrubbing outside it needs a full preview — reopen this clip to try building one again.'}
          </p>
        )}
        {!preview && (
          <p className="m-0 text-[11px] text-white/40">
            Nothing to preview yet: this clip has no finished render. Trimming and
            saving still work.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The transcript list.
 *
 * Split out because it has three states of its own -- loading, empty and
 * loaded -- and inlining them made the editor's markup hard to follow.
 */
function TranscriptPanel({
  lines,
  win,
  trimIn,
  trimOut,
  onPick,
}: {
  lines: TranscriptLine[] | null
  win: { start: number; span: number }
  trimIn: number
  trimOut: number
  onPick: (a: number, b: number) => void
}) {
  if (lines === null) {
    return <p className="m-0 text-[12px] text-white/35">Loading transcript…</p>
  }

  if (lines.length === 0) {
    return (
      <p className="m-0 text-[12px] text-white/35">
        No transcript was kept for this video.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line) => {
        const a = pctOf(line.start, win)
        const b = pctOf(line.end, win)
        // Half a percent of slack, so a line that defines the current trim still
        // reads as selected after floating-point rounding.
        const inRange = trimIn <= a + 0.5 && b <= trimOut + 0.5
        return (
          <button
            key={`${line.start}-${line.text}`}
            type="button"
            onClick={() => onPick(a, b)}
            className={cn(
              'flex cursor-pointer gap-2.5 rounded-[7px] px-[9px] py-[7px] text-left text-[12.5px] leading-[1.5] transition-colors',
              inRange ? 'bg-violet/18 text-white' : 'text-white/35 hover:bg-white/5',
            )}
          >
            <span
              className={cn('flex-none tabular-nums', inRange ? 'text-night-lilac' : 'text-white/30')}
            >
              {fmt(line.start)}
            </span>
            <span>{line.text}</span>
          </button>
        )
      })}
    </div>
  )
}
