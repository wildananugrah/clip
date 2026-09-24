/**
 * Job status writes and progress notification.
 *
 * The row is the source of truth; the NOTIFY is only a wake-up for connected
 * browsers. That ordering is what makes a mid-job refresh correct.
 */
import { eq } from 'drizzle-orm'
import { db, jobs, pool } from './db.ts'
import { NOTIFY_CHANNEL, encodeProgress } from '../../shared/progress.ts'
import { stageProgress } from '../../shared/types.ts'
import type { JobStatus } from '../../shared/types.ts'

/** Thrown when a job is cancelled mid-flight. Not an error worth logging loudly. */
export class CancelledError extends Error {
  constructor() {
    super('Job cancelled')
    this.name = 'CancelledError'
  }
}

const lastWrite = new Map<string, { progress: number; at: number }>()

/**
 * Persist progress and notify.
 *
 * ffmpeg and yt-dlp emit progress many times per second. Writing every one
 * would be thousands of UPDATEs and NOTIFYs per job for changes no human can
 * see, so a write happens only when the integer percentage moves or a second
 * has passed.
 */
export async function report(
  jobId: string,
  status: JobStatus,
  stage: string,
  fraction: number,
): Promise<void> {
  const progress = stageProgress(status, fraction)
  const prev = lastWrite.get(jobId)
  const now = Date.now()

  if (prev && prev.progress === progress && now - prev.at < 1000) return
  lastWrite.set(jobId, { progress, at: now })

  await setStatus(jobId, { status, stage, progress })
}

/** Unconditional status write plus notify. Use for stage transitions. */
export async function setStatus(
  jobId: string,
  patch: {
    status: JobStatus
    stage?: string | null
    progress?: number
    error?: string | null
    startedAt?: Date
    completedAt?: Date
  },
): Promise<void> {
  const [row] = await db
    .update(jobs)
    .set({
      status: patch.status,
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.startedAt ? { startedAt: patch.startedAt } : {}),
      ...(patch.completedAt ? { completedAt: patch.completedAt } : {}),
    })
    .where(eq(jobs.id, jobId))
    .returning()

  // If DB rejected update (e.g. jobs_keep_cancelled trigger dropped cancelled -> completed)
  // or row vanished, do not emit misleading NOTIFY
  if (!row || row.status !== patch.status) return

  const payload = encodeProgress({
    jobId,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error: row.error,
  })

  // pg_notify() as a query rather than NOTIFY, so the payload is parameterised
  // instead of string-concatenated into SQL.
  await pool.query('select pg_notify($1, $2)', [NOTIFY_CHANNEL, payload])
}

/**
 * Stop a cancelled job at the next stage boundary.
 *
 * Cancellation flips the row; the worker cannot be interrupted mid-ffmpeg, so
 * it checks between stages. Worst case a user waits out one render.
 */
export async function assertNotCancelled(jobId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CancelledError()
  const [row] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)

  if (!row || row.status === 'cancelled') throw new CancelledError()
}

export function forgetJob(jobId: string): void {
  lastWrite.delete(jobId)
}
