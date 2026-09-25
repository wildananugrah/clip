/**
 * Per-user fairness on a 4-core box with worker concurrency 1.
 *
 * Signup is open to any Google account, so without this `POST /api/jobs` is a
 * free-compute faucet: ten strangers with an hour-long video each turn into a
 * ten-hour wait for everyone behind them.
 *
 * The decision is pure over two counts so the boundaries are testable without a
 * database; the counting itself lives in the route.
 */
import { fmtBytes } from '../../shared/format.ts'

export interface QuotaCounts {
  activeCount: number
  monthlyCount: number
  monthlyLimit: number
  /**
   * Rendered bytes this user is holding, and the cap. Optional: callers that
   * predate the storage rule keep the two original rules and nothing else.
   */
  storageBytes?: number
  storageLimitBytes?: number
}

export interface QuotaRefusal {
  status: 409 | 429 | 507
  message: string
}

export function quotaVerdict({
  activeCount,
  monthlyCount,
  monthlyLimit,
  storageBytes,
  storageLimitBytes,
}: QuotaCounts): QuotaRefusal | null {
  // Reported first because it is the one the user can act on: wait, or cancel.
  if (activeCount >= 1) {
    return {
      status: 409,
      message: 'You already have a clip job running. Wait for it to finish, or cancel it.',
    }
  }

  // Before the monthly cap, because it outranks it as advice: a user who is out
  // of space AND out of slots can fix the space now, whereas the slot only
  // comes back with the new month. The disk is also the harder limit -- a job admitted
  // over it fails at the render step after spending the download.
  if (
    storageBytes !== undefined &&
    storageLimitBytes !== undefined &&
    storageBytes >= storageLimitBytes
  ) {
    return {
      status: 507,
      message: `Storage full (${fmtBytes(storageBytes)} of ${fmtBytes(storageLimitBytes)}). Delete a project to free space.`,
    }
  }

  if (monthlyCount >= monthlyLimit) {
    return {
      status: 429,
      message: `Monthly limit reached (${monthlyLimit} videos this month). It resets on the 1st.`,
    }
  }

  return null
}

/**
 * The calendar month the allowance counts over, in UTC: from the 1st of this
 * month up to (not including) the 1st of the next, which is when it resets.
 *
 * UTC rather than the viewer's zone because the server has to pick one boundary
 * for everyone, and it is the one Postgres timestamps already use.
 */
export function quotaWindow(now: Date = new Date()): { start: Date; resetsAt: Date } {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  // Date.UTC rolls month 12 over into January of the next year.
  return { start: new Date(Date.UTC(y, m, 1)), resetsAt: new Date(Date.UTC(y, m + 1, 1)) }
}
