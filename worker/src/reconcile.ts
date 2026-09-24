/**
 * Clear abandoned jobs, at worker startup.
 *
 * This is the one place the orphan rule can be decided exactly. The worker is
 * the only process that runs jobs -- `deploy.sh` refuses to start beside a
 * second one, because two workers share a queue and race for its entries -- and
 * a worker that is starting up is not running anything yet. So every job still
 * claiming to be mid-flight at this moment has been abandoned, and no timeout
 * is needed to say so.
 *
 * It matters because a killed job is not merely cosmetic: every write path
 * guards on `status === 'completed'`, so an orphan is a project whose clips can
 * no longer be saved, edited or re-cut.
 */
import { eq, notInArray } from 'drizzle-orm'
import { db, jobs, pool } from './db.ts'
import { reconcileVerdict, ORPHANED_MESSAGE } from '../../shared/reconcile.ts'
import { WORKER_APP_PREFIX, workerAppName } from '../../shared/queue.ts'
import { env } from './env.ts'
import type { JobStatus } from '../../shared/types.ts'

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

async function otherWorkersAlive(): Promise<boolean> {
  const currentApp = workerAppName(env.WORKER_HOST_ID)
  // Check if any other worker connection is alive in Postgres
  const res = await pool.query<{ count: string }>(
    `SELECT count(*) FROM pg_stat_activity 
     WHERE datname = current_database() 
       AND application_name LIKE $1 
       AND application_name <> $2`,
    [`${WORKER_APP_PREFIX}:%`, currentApp],
  )
  return parseInt(res.rows[0]?.count ?? '0', 10) > 0
}

export async function reconcileOnBoot(): Promise<{ completed: number; failed: number }> {
  const stuck = await db.select().from(jobs).where(notInArray(jobs.status, TERMINAL))

  let completed = 0
  let failed = 0

  const hasPeers = await otherWorkersAlive().catch(() => false)
  // If other workers are running, jobs in flight belong to them; don't fail them!
  const nothingIsRunning = !hasPeers

  for (const job of stuck) {
    const verdict = reconcileVerdict(job, { nothingIsRunning })

    if (verdict === 'completed') {
      // Finished, then polluted by a re-cut announcing its own download.
      await db
        .update(jobs)
        .set({ status: 'completed', stage: 'Done', progress: 100, error: null })
        .where(eq(jobs.id, job.id))
      completed++
    } else if (verdict === 'failed') {
      await db
        .update(jobs)
        .set({
          status: 'failed',
          stage: 'Failed',
          error: ORPHANED_MESSAGE,
          completedAt: new Date(),
        })
        .where(eq(jobs.id, job.id))
      failed++
    }
  }

  return { completed, failed }
}
