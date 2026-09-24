/**
 * Worker entrypoint. Consumes the pg-boss queues and runs the pipeline.
 *
 * Concurrency defaults to 1: whisper and x264 each want every core, so
 * overlapping jobs make both slower and risk the OOM killer on a box with
 * ~4GB free.
 */
import { mkdir } from 'node:fs/promises'
import pg from 'pg'
import {
  makeBoss,
  workerAppName,
  PROCESS_QUEUE,
  RECUT_QUEUE,
  BACKFILL_QUEUE,
  SOURCE_QUEUE,
} from '../../shared/queue.ts'
import type {
  ProcessJobPayload,
  RecutJobPayload,
  BackfillJobPayload,
  SourceJobPayload,
} from '../../shared/queue.ts'
import { CANCEL_CHANNEL } from '../../shared/progress.ts'
import { env } from './env.ts'
import { db, jobs, pool, storage, assertStorageReady } from './db.ts'
import { eq } from 'drizzle-orm'
import { processJob, recutClip, backfillAssets, buildSourceProxy } from './pipeline.ts'
import { sweepSourceProxies, sweepSources } from './retention.ts'
import { reclaimSourceLeases, sourcesDir } from './sourceCache.ts'
import { reconcileOnBoot } from './reconcile.ts'
import { assertEncoderAvailable } from './ffmpeg.ts'

const boss = makeBoss(env.DATABASE_URL, workerAppName(env.WORKER_HOST_ID))

let shuttingDown = false

// Track in-flight job controllers so NOTIFY job_cancel can abort them immediately
const activeJobs = new Map<string, AbortController>()

let cancelListener: pg.Client | null = null
let cancelReconnectTimer: ReturnType<typeof setTimeout> | null = null

async function listenForCancels() {
  if (shuttingDown) return
  if (cancelListener) {
    await cancelListener.end().catch(() => {})
    cancelListener = null
  }
  const c = new pg.Client({
    connectionString: env.DATABASE_URL,
    application_name: `${workerAppName(env.WORKER_HOST_ID)}:cancel`,
  })
  c.on('notification', (msg) => {
    if (msg.channel === CANCEL_CHANNEL && msg.payload) {
      const jobId = msg.payload.trim()
      const controller = activeJobs.get(jobId)
      if (controller) {
        console.log(`[worker] received cancel signal for active job ${jobId}`)
        controller.abort()
      }
    }
  })
  const onEnd = () => {
    c.end().catch(() => {})
    if (cancelListener === c) cancelListener = null
    if (!shuttingDown && !cancelReconnectTimer) {
      cancelReconnectTimer = setTimeout(() => {
        cancelReconnectTimer = null
        void listenForCancels()
      }, 1500)
    }
  }
  c.on('error', (err) => {
    console.error('[worker] cancel listener error, reconnecting:', err.message)
    onEnd()
  })
  c.on('end', () => {
    console.warn('[worker] cancel listener connection ended, reconnecting')
    onEnd()
  })
  try {
    await c.connect()
    await c.query(`LISTEN ${CANCEL_CHANNEL}`)
    if (shuttingDown) {
      await c.end().catch(() => {})
      return
    }
    cancelListener = c
  } catch (err) {
    await c.end().catch(() => {})
    console.error('[worker] failed to connect cancel listener:', (err as Error).message)
    if (!shuttingDown && !cancelReconnectTimer) {
      cancelReconnectTimer = setTimeout(() => {
        cancelReconnectTimer = null
        void listenForCancels()
      }, 2000)
    }
  }
}
void listenForCancels()

boss.on('error', (err) => console.error('[boss]', err))

await mkdir(env.WORK_DIR, { recursive: true })
// The shared cache directory, created up front so reclaim can read it on a
// first-ever boot rather than swallowing an ENOENT.
await mkdir(sourcesDir(), { recursive: true })

// Before claiming any work: a worker with nowhere to put its output cannot do
// its job, and finding that out after a 40-minute transcription is the failure
// assertWhisperAvailable() already exists to prevent.
try {
  await assertStorageReady()
  await assertEncoderAvailable()
} catch (e) {
  console.error(`[worker] ${(e as Error).message}`)
  process.exit(1)
}

/**
 * Before claiming anything: this worker is the only thing that runs jobs, and
 * it is not running one yet -- so any job still claiming to be mid-flight was
 * abandoned by a previous process. Left alone, each one is a project that can
 * never be saved or re-cut again.
 */
{
  const repaired = await reconcileOnBoot().catch((e: Error) => {
    console.error('[worker] job reconcile failed:', e.message)
    return null
  })
  if (repaired && (repaired.completed || repaired.failed)) {
    console.log(
      `[worker] reconciled jobs: ${repaired.completed} restored to completed, ` +
        `${repaired.failed} marked failed`,
    )
  }
}

await boss.start()
await boss.createQueue(PROCESS_QUEUE)
await boss.createQueue(RECUT_QUEUE)
await boss.createQueue(BACKFILL_QUEUE)
await boss.createQueue(SOURCE_QUEUE)

/**
 * Take back the source leases this host was holding when it last died.
 *
 * Same reasoning as the job reconcile above, applied to files: a booting worker
 * holds no leases, so a row still claiming otherwise was abandoned by a dead
 * process. Left alone it is a multi-gigabyte file the sweep will never touch,
 * at any size, by any rule.
 *
 * BEFORE THE SWEEPS, NOT AFTER. A sweep run first would see those rows as in
 * use and spare exactly the files this recovers.
 */
{
  const reclaimed = await reclaimSourceLeases().catch((e: Error) => {
    console.error('[sources] lease reclaim failed:', e.message)
    return null
  })
  if (reclaimed && (reclaimed.leases || reclaimed.partials)) {
    console.log(
      `[sources] reclaimed ${reclaimed.leases} leaked lease(s) and cleared ` +
        `${reclaimed.partials} interrupted download(s) -- last exit was unclean`,
    )
  }
}

// Once at startup, so an eviction that was blocked by a busy editor last night
// is not waiting on somebody opening manual mode again to be retried.
await sweepSourceProxies().catch((e) => {
  console.error('[retention] startup sweep failed:', (e as Error).message)
})

await sweepSources().catch((e) => {
  console.error('[sources] startup sweep failed:', (e as Error).message)
})

await boss.work<ProcessJobPayload>(
  PROCESS_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (!job) return
    console.log(`[worker] processing job ${job.data.jobId}`)
    const controller = new AbortController()
    activeJobs.set(job.data.jobId, controller)
    try {
      // processJob owns its own error handling and writes the failure to the row;
      // throwing here would only mark the queue entry failed, which no UI reads.
      await processJob(job.data.jobId, controller.signal)
    } finally {
      if (activeJobs.get(job.data.jobId) === controller) {
        activeJobs.delete(job.data.jobId)
      }
    }
    console.log(`[worker] finished job ${job.data.jobId}`)
  },
)

await boss.work<RecutJobPayload>(
  RECUT_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (!job) return
    console.log(`[worker] recutting clip ${job.data.clipId}`)
    await recutClip(job.data.jobId, job.data.clipId)
  },
)

await boss.work<BackfillJobPayload>(
  BACKFILL_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (!job) return
    console.log(`[worker] backfilling editor assets for job ${job.data.jobId}`)
    // Owns its own error handling: a preview that cannot be built must not mark
    // a finished project failed.
    await backfillAssets(job.data.jobId)
  },
)

/**
 * Its own registration, not a branch inside the backfill handler.
 *
 * pg-boss gives each `work()` its own poller, so a fifteen-minute source build
 * for a four-hour podcast drains alongside clip work instead of standing in
 * front of it. The handlers still run one at a time within a queue, which is
 * what batchSize 1 is for.
 */
await boss.work<SourceJobPayload>(
  SOURCE_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 2 },
  async ([job]) => {
    if (!job) return
    console.log(`[worker] building source assets for video ${job.data.videoId}`)
    // Owns its own error handling, and runs the retention sweep afterwards.
    await buildSourceProxy(job.data.videoId, job.data.jobId)
  },
)

console.log(
  `worker ready (storage "${(await storage.active()).id}", whisper "${env.WHISPER_MODEL}", ` +
    `work dir ${env.WORK_DIR})`,
)

// let shuttingDown handled at top
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    if (cancelReconnectTimer) {
      clearTimeout(cancelReconnectTimer)
      cancelReconnectTimer = null
    }
    console.log(`\n[worker] ${signal} -- finishing current work, then exiting`)
    // stop() waits for in-flight handlers, so a job mid-transcription is not
    // abandoned halfway with its scratch directory left behind.
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => {})
    await cancelListener?.end().catch(() => {})
    await pool.end().catch(() => {})
    process.exit(0)
  })
}
