import { test, expect, describe } from 'bun:test'
import { clampClipCount, etaForCount, jobIndicator, quota, storage } from './derive'

/**
 * The one place that decides whether "a video is being processed" is worth
 * showing, and what it says. Both the sidebar entry and the banner read this, so
 * they cannot drift apart.
 */
describe('jobIndicator', () => {
  const active = { jobId: 'job-1', jobStatus: 'transcribing' as const, stage: 'Transcribing (12m of 48m)', progress: 42 }

  test('nothing to show when no job has ever run', () => {
    expect(jobIndicator({ jobId: '', jobStatus: null, stage: null, progress: 0 }).visible).toBe(false)
  })

  test('a running job is visible', () => {
    expect(jobIndicator(active).visible).toBe(true)
  })

  test("it reports the server's stage text, not a generic word", () => {
    expect(jobIndicator(active).label).toBe('Transcribing (12m of 48m)')
  })

  test('it falls back to a generic label before the first stage arrives', () => {
    const fresh = { jobId: 'job-1', jobStatus: 'pending' as const, stage: null, progress: 0 }
    expect(jobIndicator(fresh).label).toBe('Processing…')
  })

  test('it carries the percentage for the bar', () => {
    expect(jobIndicator(active).percent).toBe(42)
  })

  test('clicking a running job goes to the progress screen', () => {
    expect(jobIndicator(active).target).toBe('processing')
  })

  test('every mid-pipeline status counts as running', () => {
    for (const jobStatus of ['pending', 'downloading', 'transcribing', 'analyzing', 'rendering'] as const) {
      const out = jobIndicator({ ...active, jobStatus })
      expect(out.visible).toBe(true)
      expect(out.tone).toBe('active')
    }
  })

  test('a finished job flips to a done state rather than vanishing', () => {
    const out = jobIndicator({ ...active, jobStatus: 'completed', progress: 100 })
    expect(out.visible).toBe(true)
    expect(out.tone).toBe('done')
    expect(out.label).toBe('Clips ready')
  })

  test('a finished job sends you to the clips, not back to the progress screen', () => {
    expect(jobIndicator({ ...active, jobStatus: 'completed' }).target).toBe('results')
  })

  test('a done state always reads 100%, even if the last frame missed', () => {
    expect(jobIndicator({ ...active, jobStatus: 'completed', progress: 97 }).percent).toBe(100)
  })

  test('a failed job stays visible -- silently vanishing loses a 40-minute failure', () => {
    const out = jobIndicator({ ...active, jobStatus: 'failed' })
    expect(out.visible).toBe(true)
    expect(out.tone).toBe('failed')
    expect(out.label).toBe('Job failed')
    // The processing screen is where the error text lives.
    expect(out.target).toBe('processing')
  })

  test('a job the user cancelled is not worth reporting', () => {
    expect(jobIndicator({ ...active, jobStatus: 'cancelled' }).visible).toBe(false)
  })

  test('percentage is clamped, so a bad frame cannot overflow the bar', () => {
    expect(jobIndicator({ ...active, progress: 140 }).percent).toBe(100)
    expect(jobIndicator({ ...active, progress: -5 }).percent).toBe(0)
  })
})

/**
 * The allowance shown in the sidebar. Driven entirely by the server's count,
 * because the local counter it replaced reset to zero on every reload and
 * reported "3 of 3 free videos left" after a video had already been generated.
 */
describe('quota', () => {
  const at = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()

  test('before the server has answered, it does not invent a number', () => {
    const q = quota(null)
    expect(q.known).toBe(false)
  })

  test('the shape is the same whether or not the server has answered', () => {
    // Callers destructure this; a missing field is a type error at the call site.
    expect(Object.keys(quota(null)).sort()).toEqual(
      Object.keys(quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null })).sort(),
    )
  })

  test('remaining is exposed for callers that need the number itself', () => {
    expect(quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null }).remaining).toBe(2)
    expect(quota(null).remaining).toBe(0)
  })

  test('it counts down from the limit the server reports', () => {
    const q = quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: at(3_600_000) })
    expect(q.known).toBe(true)
    expect(q.label).toBe('2 of 3 videos left this month')
  })

  test('it does not use a hardcoded allowance', () => {
    // QUOTA_JOBS_PER_MONTH is configurable; 3 must not be baked in.
    const q = quota({ used: 2, limit: 10, remaining: 8, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: at(3_600_000) })
    expect(q.label).toBe('8 of 10 videos left this month')
  })

  test('the used label reads as a fraction for the meter', () => {
    expect(quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null }).usedLabel).toBe('1 of 3')
  })

  test('the bar width tracks what has been spent', () => {
    expect(quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null }).width).toBe('33%')
    expect(quota({ used: 3, limit: 3, remaining: 0, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null }).width).toBe('100%')
  })

  test('being over the limit cannot overflow the bar', () => {
    expect(quota({ used: 5, limit: 3, remaining: 0, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null }).width).toBe('100%')
  })

  test('an exhausted allowance says so plainly', () => {
    const q = quota({ used: 3, limit: 3, remaining: 0, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: at(3_600_000) })
    expect(q.label).toBe('No videos left this month')
    expect(q.exhausted).toBe(true)
  })

  test('no reset time means nothing to say, rather than a made-up date', () => {
    const q = quota({ used: 0, limit: 3, remaining: 3, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: null })
    expect(q.resetLabel).toBe('')
    expect(q.resetDate).toBe('')
  })

  test('it names the day the month resets', () => {
    const q = quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: '2026-10-01T00:00:00.000Z' })
    expect(q.resetDate).toBe('1 October')
    expect(q.resetLabel).toBe('Resets on 1 October')
  })

  test('the reset day is read in UTC, so it is the 1st in every time zone', () => {
    // In a zone west of UTC this instant is still 31 December locally.
    const q = quota({ used: 1, limit: 3, remaining: 2, storageBytes: 0, storageLimitBytes: 5 * 1024 ** 3, resetsAt: '2027-01-01T00:00:00.000Z' })
    expect(q.resetDate).toBe('1 January')
  })
})

/**
 * The custom clip count. Bounded by the same 1-24 the API enforces, so a typed
 * number cannot reach the server only to come back as a 400.
 */
describe('clampClipCount', () => {
  test('a normal number passes through', () => {
    expect(clampClipCount('17')).toBe(17)
  })

  test('the boundaries are allowed', () => {
    expect(clampClipCount('1')).toBe(1)
    expect(clampClipCount('24')).toBe(24)
  })

  test('above the maximum clamps down -- the API rejects 25', () => {
    expect(clampClipCount('25')).toBe(24)
    expect(clampClipCount('999')).toBe(24)
  })

  test('below the minimum clamps up', () => {
    expect(clampClipCount('0')).toBe(1)
    expect(clampClipCount('-4')).toBe(1)
  })

  test('a decimal is floored to a whole clip', () => {
    // You cannot render three and a half clips.
    expect(clampClipCount('3.7')).toBe(3)
  })

  test('an empty box falls back to the default rather than 0', () => {
    expect(clampClipCount('')).toBe(12)
    expect(clampClipCount('   ')).toBe(12)
  })

  test('nonsense falls back to the default', () => {
    expect(clampClipCount('abc')).toBe(12)
    expect(clampClipCount('12abc')).toBe(12)
  })

  test('it accepts a number as well as a string', () => {
    expect(clampClipCount(30)).toBe(24)
    expect(clampClipCount(8)).toBe(8)
  })
})

/**
 * The ETA shown on the setup screen, recomputed as the clip count changes.
 *
 * This DUPLICATES estimateEta in shared/format.ts, because the frontend does not
 * import across the workspace. Every expected value below was generated by
 * running that shared function, so if the two ever drift apart these fail:
 *
 *   bun -e 'import {estimateEta} from "./shared/format.ts"; console.log(estimateEta(2712, 24))'
 */
describe('etaForCount', () => {
  test('matches the server for a 45 minute source across the presets', () => {
    expect(etaForCount(2712, 6)).toBe('~22 min')
    expect(etaForCount(2712, 12)).toBe('~24 min')
    expect(etaForCount(2712, 24)).toBe('~29 min')
  })

  test('more clips means a longer estimate -- this is why it must react', () => {
    // The screen used to show the 12-clip figure whatever you picked.
    expect(etaForCount(2712, 24)).not.toBe(etaForCount(2712, 12))
  })

  test('matches the server for a two hour source', () => {
    expect(etaForCount(7104, 12)).toBe('~53 min')
  })

  test('rolls over into hours exactly as the server does', () => {
    expect(etaForCount(14400, 24)).toBe('~1 hr 47 min')
  })

  test('never promises less than a minute', () => {
    expect(etaForCount(0, 1)).toBe('~1 min')
    expect(etaForCount(60, 1)).toBe('~2 min')
  })
})

/**
 * The storage row on the plan screen. Was hardcoded to "1.2 GB of 5 GB" from
 * the prototype, which made a full account look a quarter full.
 */
describe('storage', () => {
  const GB = 1024 ** 3
  const q = (storageBytes: number, storageLimitBytes: number) => ({
    used: 0,
    limit: 3,
    remaining: 3,
    storageBytes,
    storageLimitBytes,
    resetsAt: null,
  })

  test('before the server has answered, it does not invent a number', () => {
    expect(storage(null).known).toBe(false)
  })

  test('the shape is the same whether or not the server has answered', () => {
    expect(Object.keys(storage(null)).sort()).toEqual(Object.keys(storage(q(0, 5 * GB))).sort())
  })

  test('it reports both sides in units a person reads', () => {
    expect(storage(q(1.2 * GB, 5 * GB)).label).toBe('1.2 GB of 5.0 GB')
  })

  test('the bar tracks the real fraction', () => {
    expect(storage(q(1 * GB, 4 * GB)).width).toBe('25%')
  })

  test('an empty account reads zero, not NaN', () => {
    const s = storage(q(0, 5 * GB))
    expect(s.width).toBe('0%')
    expect(s.label).toContain('0 B')
  })

  test('a limit of zero does not divide by zero', () => {
    expect(storage(q(0, 0)).width).toBe('100%')
  })

  test('over the cap clamps at full rather than overflowing the bar', () => {
    const s = storage(q(9 * GB, 5 * GB))
    expect(s.width).toBe('100%')
    expect(s.full).toBe(true)
  })
})
