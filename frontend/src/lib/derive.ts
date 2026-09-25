import {
  CLIP_COUNT_DEFAULT,
  CLIP_COUNT_MAX,
  CLIP_COUNT_MIN,
  EXPORT_SIZES,
} from '../data/fixtures'
import { fmtBytes } from './format'
import { isTerminal } from '../../../shared/types'
import type { Clip, JobStatus, QuotaDTO, Ratio, Screen } from '../types'

/**
 * The monthly allowance, from the server's count.
 *
 * This used to take a local `videosUsed` counter that the app incremented itself.
 * That counter started at zero on every reload, was never persisted and knew
 * nothing about jobs created on another device -- so after generating one video
 * the sidebar still said "3 of 3 free videos left". The allowance is a calendar
 * month (UTC) enforced on the server (quota.ts), and only the server can count
 * it.
 *
 * `known: false` while the fetch is in flight, so the UI can stay quiet rather
 * than show a number that is probably wrong.
 */
export function quota(q: QuotaDTO | null) {
  // Same shape in both branches: callers destructure this, so a field that only
  // exists once the server has answered is a type error at the call site.
  if (!q) {
    return {
      known: false,
      label: '',
      usedLabel: '',
      width: '0%',
      resetLabel: '',
      resetDate: '',
      exhausted: false,
      remaining: 0,
    }
  }

  const remaining = Math.max(0, q.remaining)
  const spent = Math.min(q.used, q.limit)

  return {
    known: true,
    label:
      remaining === 0
        ? 'No videos left this month'
        : `${remaining} of ${q.limit} videos left this month`,
    usedLabel: `${q.used} of ${q.limit}`,
    // Clamped: a limit lowered after jobs were created would otherwise push the
    // meter past its track.
    width: `${q.limit === 0 ? 100 : Math.round((spent / q.limit) * 100)}%`,
    resetLabel: resetDate(q.resetsAt) ? `Resets on ${resetDate(q.resetsAt)}` : '',
    resetDate: resetDate(q.resetsAt),
    exhausted: remaining === 0,
    remaining,
  }
}

/**
 * Rendered storage held, from the server's sum of `renders.size_bytes`.
 *
 * Separate from `quota` above because the two behave differently: the monthly
 * count only falls when the month turns, while this one falls the moment a project is
 * deleted. Same `known: false` treatment while the fetch is in flight.
 */
export function storage(q: QuotaDTO | null) {
  if (!q) {
    return { known: false, label: '', width: '0%', full: false }
  }

  const { storageBytes: used, storageLimitBytes: limit } = q
  // A cap of zero is "no room", not "unlimited" -- and not a division by zero.
  const pct = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100))

  return {
    known: true,
    label: `${fmtBytes(used)} of ${fmtBytes(limit)}`,
    width: `${pct}%`,
    full: used >= limit,
  }
}

/**
 * The day the allowance resets, e.g. "1 October".
 *
 * Formatted in UTC because that is the zone the server's month is counted in:
 * midnight on the 1st UTC is still 30 September west of Greenwich, and saying
 * so would contradict the "1st of the month" rule everywhere else.
 */
function resetDate(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
}

export function formatsLabel(formats: Record<Ratio, boolean>): string {
  const on = (Object.keys(formats) as Ratio[]).filter((k) => formats[k])
  return on.join(' and ') || 'none selected'
}

export function exportLabel(filter: Ratio, subs: boolean): string {
  return EXPORT_SIZES[filter] + (subs ? ' · subtitles burned in' : '')
}

/** The CSS aspect ratio for cards under the current format tab. */
export function clipAspect(filter: Ratio): string {
  return filter === '1:1' ? '1/1' : filter === '4:5' ? '4/5' : '9/16'
}

export function sortClips(clips: Clip[], byScore: boolean): Clip[] {
  return byScore ? [...clips].sort((a, b) => b.sc - a.sc) : [...clips].sort((a, b) => a.s - b.s)
}

export function selectedCount(clips: Clip[]): number {
  return clips.filter((c) => c.selected).length
}

/**
 * A re-cut used to shadow the headline with a `title` field. The server now
 * returns the current headline in `t`, so there is nothing left to resolve --
 * kept as a function so call sites need not change.
 */
export function clipTitle(clip: Clip): string {
  return clip.t
}

/** What the progress indicator should say, or that it should stay hidden. */
export interface JobIndicator {
  visible: boolean
  tone: 'active' | 'done' | 'failed'
  label: string
  /** 0-100, safe to feed straight to a width. */
  percent: number
  /** Where a click should land. */
  target: Screen
}

/**
 * The single decision behind the sidebar entry AND the banner.
 *
 * Both surfaces render from this, so they cannot disagree about whether a job is
 * running or what it is called. Takes only the four fields it needs rather than
 * the whole state, which keeps it trivially testable.
 *
 * A finished job does not disappear: it flips to "Clips ready" so the work is
 * still one click away from wherever you happen to be. A failed job stays too --
 * silently vanishing is how you would lose a 40-minute failure without noticing.
 * A cancelled job is the one case worth hiding, because you asked for that.
 */
export function jobIndicator(job: {
  jobId: string
  jobStatus: JobStatus | null
  stage: string | null
  progress: number
}): JobIndicator {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
  const hidden: JobIndicator = {
    visible: false,
    tone: 'active',
    label: '',
    percent: 0,
    target: 'processing',
  }

  if (!job.jobId || !job.jobStatus) return hidden

  switch (job.jobStatus) {
    case 'completed':
      // Pinned to 100: the last SSE frame is sometimes missed, and a "ready"
      // badge sitting at 97% looks broken.
      return { visible: true, tone: 'done', label: 'Clips ready', percent: 100, target: 'results' }

    case 'failed':
      return {
        visible: true,
        tone: 'failed',
        label: 'Job failed',
        percent: clamp(job.progress),
        // The processing screen is where the error text is shown.
        target: 'processing',
      }

    case 'cancelled':
      return hidden

    default:
      return {
        visible: true,
        tone: 'active',
        label: job.stage ?? 'Processing…',
        percent: clamp(job.progress),
        target: 'processing',
      }
  }
}

/**
 * Bring a typed clip count into the range the API will actually accept.
 *
 * Clamping here rather than letting the server refuse means a typo becomes a
 * corrected number instead of a 400 after the user has already committed. An
 * empty or unparseable box falls back to the default, so clearing the field to
 * retype never means "zero clips".
 */
export function clampClipCount(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  // Number('') is 0 and Number('abc') is NaN; neither is a count the user meant.
  if (!Number.isFinite(n) || String(raw).trim() === '') return CLIP_COUNT_DEFAULT
  // Floor, not round: you cannot render part of a clip, and rounding 3.7 up to 4
  // would silently add work nobody asked for.
  return Math.min(CLIP_COUNT_MAX, Math.max(CLIP_COUNT_MIN, Math.floor(n)))
}

/**
 * How long a job of `clipCount` clips is likely to take, as a display hint.
 *
 * MIRRORS estimateEta in shared/format.ts. The frontend does not import across
 * the workspace, so the formula lives twice; derive.test.ts pins these values
 * against the shared function's real output so drift shows up as a failure
 * rather than a quietly wrong estimate.
 *
 * The setup screen needs its own copy because the server computes `source.eta`
 * before a job exists, with clipCount defaulting to 12 -- so it never reacted to
 * what the user actually picked, and a 24-clip job was under-estimated by five
 * minutes.
 */
export function etaForCount(durationSeconds: number, clipCount: number): string {
  const seconds = durationSeconds * 0.4 + clipCount * 25 + 60
  const mins = Math.max(1, Math.round(seconds / 60))
  if (mins < 60) return `~${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`
}

/**
 * Is any project still working?
 *
 * The whole of the polling decision, kept pure so it can be tested without
 * timers or a React tree -- the same split retention.ts and sourceCache.ts use
 * on the server.
 *
 * `isTerminal` rather than a hand-written list: 'failed' and 'cancelled' are
 * terminal, so a project that failed stops the poll instead of spinning against
 * the API forever.
 */
export function anyProjectRunning(projects: { status: JobStatus }[]): boolean {
  return projects.some((p) => !isTerminal(p.status))
}
