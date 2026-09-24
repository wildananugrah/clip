import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { eq, and, desc, exists, inArray, isNull, or, not, sql } from 'drizzle-orm'
import { db, pool, jobs, videos, clips, renders } from '../db/index.ts'
import { editorGate } from '../editorGate.ts'
import {
  ownedJob,
  activeJob,
  quotaUsage,
  countActiveJobs,
  countJobsSince,
  storageUsage,
} from '../ownership.ts'
import { quotaVerdict } from '../quota.ts'
import { env } from '../env.ts'
import { toJobDTO, toSourceDTO } from '../mappers.ts'
import {
  enqueueProcess,
  enqueueBackfill,
  enqueueSourceAssets,
  boss,
  PROCESS_QUEUE,
} from '../queue.ts'
import { subscribe, ensureListening } from '../events.ts'
import { isTerminal, MAX_PROMPT_CHARS, RATIOS, TERMINAL_STATUSES } from '../../../shared/types.ts'
import type { ProjectDTO, QuotaDTO, Ratio } from '../../../shared/types.ts'
import { CANCEL_CHANNEL, NOTIFY_CHANNEL, encodeProgress } from '../../../shared/progress.ts'
import { storage } from '../s3.ts'

const createBody = z.object({
  videoId: z.string().uuid(),
  count: z.number().int().min(1).max(24),
  lengthIdx: z.number().int().min(0).max(2),
  formats: z.record(z.boolean()),
  subs: z.boolean(),
  /**
   * Optional brief steering which moments get picked. Capped because it is
   * pasted into an LLM prompt: a caller is otherwise free to send a megabyte
   * and make every job of theirs cost a fortune in tokens. 500 is generous for
   * a sentence or two of "what I'm after". Shared with the textarea's
   * maxLength so the box cannot accept what this would reject.
   */
  prompt: z.string().trim().max(MAX_PROMPT_CHARS).optional(),
})

export const jobsRoutes = new Hono()

/** Create and enqueue a job. */
jobsRoutes.post('/', async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }
  const b = parsed.data

  const enabled = RATIOS.filter((r) => b.formats[r])
  if (enabled.length === 0) {
    return c.json({ error: 'Pick at least one output format.' }, 400)
  }

  // Signup is open to any Google account and the worker runs one job at a time,
  // so this is what stops one person queueing the box out from under everyone.
  const user = c.get('user')
  const refusal = quotaVerdict({
    activeCount: await countActiveJobs(user.id),
    dailyCount: await countJobsSince(user.id, new Date(Date.now() - 86_400_000)),
    // A per-user override exists so one account can be raised (or cut) without
    // moving the global default for everyone. See backend/scripts/quota.ts.
    dailyLimit: user.dailyJobLimit ?? env.QUOTA_JOBS_PER_DAY,
    storageBytes: await storageUsage(user.id),
    storageLimitBytes: user.storageLimitBytes ?? env.QUOTA_STORAGE_GB * 1024 ** 3,
  })
  if (refusal) return c.json({ error: refusal.message }, refusal.status)

  const [video] = await db.select().from(videos).where(eq(videos.id, b.videoId)).limit(1)
  if (!video) return c.json({ error: 'Unknown video. Analyse the URL again.' }, 404)

  const [job] = await db
    .insert(jobs)
    .values({
      userId: user.id,
      videoId: video.id,
      clipCount: b.count,
      lengthPreset: b.lengthIdx,
      formats: Object.fromEntries(enabled.map((r) => [r, true])),
      burnSubtitles: b.subs,
      // '' and "  " both mean no brief; store NULL so the worker has one case.
      prompt: b.prompt || null,
      status: 'pending',
      stage: 'Queued',
    })
    .returning()

  await enqueueProcess({ jobId: job.id })

  return c.json({ jobId: job.id }, 201)
})

/**
 * The job still running, or null.
 *
 * MUST stay above '/:id': Hono matches in registration order, so declaring this
 * second would make '/active' parse as a job id and 404 forever.
 *
 * Lets the app show "processing…" on any screen without having to remember an id
 * across reloads or devices -- see activeJob in ownership.ts.
 */
jobsRoutes.get('/active', async (c) => {
  const job = await activeJob(c.get('user').id)
  if (!job) return c.json(null)

  const found = await loadJob(c.get('user').id, job.id)
  if (!found) return c.json(null)
  return c.json(await toJobDTO(found.job, found.video, found.clipRows, found.renderRows))
})

/**
 * The daily allowance, as the server counts it. Also above '/:id'.
 *
 * The UI used to keep its own counter, incrementing on job creation. It started
 * at zero on every reload and knew nothing about jobs created on another device,
 * so it reported three videos left after one had been generated. The server is
 * the only place the rolling window actually exists.
 */
jobsRoutes.get('/quota', async (c) => {
  const windowStart = new Date(Date.now() - 86_400_000)
  const user = c.get('user')
  const { used, oldestAt } = await quotaUsage(user.id, windowStart)
  const limit = user.dailyJobLimit ?? env.QUOTA_JOBS_PER_DAY

  const quota: QuotaDTO = {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    storageBytes: await storageUsage(user.id),
    storageLimitBytes: user.storageLimitBytes ?? env.QUOTA_STORAGE_GB * 1024 ** 3,
    // 24h after the oldest job in the window, that job drops out and its slot
    // comes back. Null when nothing is spent.
    resetsAt: oldestAt ? new Date(oldestAt.getTime() + 86_400_000).toISOString() : null,
  }
  return c.json(quota)
})

/** Full job state: options, source, clips, presigned render URLs. */
jobsRoutes.get('/:id', async (c) => {
  const found = await loadJob(c.get('user').id, c.req.param('id'))
  if (!found) return c.json({ error: 'Job not found' }, 404)
  return c.json(await toJobDTO(found.job, found.video, found.clipRows, found.renderRows))
})

/**
 * Progress stream. Emits the current state immediately so a page refresh does
 * not wait for the next worker tick, then closes once the job is terminal.
 */
jobsRoutes.get('/:id/events', async (c) => {
  const jobId = c.req.param('id')
  const job = await ownedJob(c.get('user').id, jobId)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  await ensureListening()

  return streamSSE(c, async (stream) => {
    let unsubscribe = () => {}
    const done = new Promise<void>((resolve) => {
      unsubscribe = subscribe(jobId, (event) => {
        void stream.writeSSE({ data: JSON.stringify(event) })
        if (isTerminal(event.status)) resolve()
      })
    })

    await stream.writeSSE({
      data: JSON.stringify({
        jobId,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        error: job.error,
      }),
    })

    // Already finished before the browser connected: nothing more will arrive.
    if (isTerminal(job.status)) {
      unsubscribe()
      return
    }

    // A proxy that sees no bytes for 60s will drop the connection; nginx's
    // default proxy_read_timeout is exactly that. Comment frames keep it warm
    // during a 40-minute transcription that reports rarely.
    const keepAlive = setInterval(() => void stream.writeSSE({ data: '', event: 'ping' }), 20_000)

    stream.onAbort(() => {
      unsubscribe()
      clearInterval(keepAlive)
    })

    await done
    unsubscribe()
    clearInterval(keepAlive)
  })
})

jobsRoutes.post('/:id/cancel', async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)
  if (isTerminal(job.status)) return c.json({ ok: true, status: job.status })

  const finalStatus = await cancelJob(id)
  return c.json({ ok: true, status: finalStatus })
})

/** Re-run a job from scratch, reusing the source and its transcript. */
// Revert unnecessary regenerate route change
jobsRoutes.post('/:id/regenerate', async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  await deleteJobArtifacts(id)

  await db
    .update(jobs)
    .set({
      status: 'pending',
      stage: 'Queued',
      progress: 0,
      error: null,
      startedAt: null,
      completedAt: null,
    })
    .where(eq(jobs.id, id))

  await enqueueProcess({ jobId: id })
  return c.json({ jobId: id })
})

/**
 * Ask for the editor's preview assets for a project that has none.
 *
 * Clips cut before the editor had a proxy have nothing to scrub, and re-cutting
 * one just to get a preview would re-encode a video that was already correct.
 * This enqueues one download that fills in every clip of the job.
 *
 * Idempotent: the queue collapses duplicates by job id, and a project whose
 * clips all have assets answers 204 without enqueuing anything -- the editor
 * calls this whenever it opens a clip without a proxy.
 */
jobsRoutes.post('/:id/assets', editorGate, async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // The renders have to exist before anything can be added alongside them, and
  // a running job is about to build these itself. A job that has STOPPED --
  // however it ended -- is not going to touch them again, so its clips can be
  // backfilled like any other.
  if (!isTerminal(job.status)) {
    return c.json({ error: 'Wait for the job to finish first.' }, 409)
  }

  const rows = await db.select().from(clips).where(eq(clips.jobId, id))
  if (rows.length === 0 || rows.every((r) => r.proxyKey)) return c.body(null, 204)

  await enqueueBackfill({ jobId: id })
  return c.json({ ok: true, pending: rows.filter((r) => !r.proxyKey).length })
})

/**
 * Ensure the FULL-LENGTH editor assets exist for this job's source, so manual
 * mode can place the timeline window anywhere in the video.
 *
 * Also the only place `proxy_used_at` is written on read, which makes it the
 * whole least-recently-used mechanism: retention orders by that column, so a
 * source somebody is working on is structurally the last thing evicted.
 */
jobsRoutes.post('/:id/source', editorGate, async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // Same rule as every other write path: a job still in flight is about to
  // rewrite its own clips, and this hands one of them out to be edited.
  if (!isTerminal(job.status)) {
    return c.json({ error: 'Wait for the job to finish first.' }, 409)
  }

  const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
  if (!video) return c.json({ error: 'Source video is missing' }, 404)

  if (video.proxyKey) {
    await db.update(videos).set({ proxyUsedAt: new Date() }).where(eq(videos.id, video.id))
    return c.json({ ready: true })
  }

  // Singleton on the video id, so two users editing the same source -- or one
  // user with two projects from it -- share a single download and encode.
  await enqueueSourceAssets({ videoId: video.id, jobId: id })
  return c.json({ ready: false, pending: true })
})

/**
 * Delete a project. Reachable as DELETE /api/projects/:id too -- index.ts mounts
 * this router under both prefixes.
 */
jobsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const job = await ownedJob(c.get('user').id, id)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // Cancel first: deleting the clips of a job the worker is still writing to
  // would race it, and the worker only notices a cancel at a stage boundary.
  if (!isTerminal(job.status)) await cancelJob(id)

  await softDeleteJob(id)
  return c.json({ ok: true })
})

/**
 * A user's reachable, undeleted projects, newest first.
 *
 * Reachable means FINISHED WITH and not empty, which is not the same as
 * 'completed'. A job killed mid-flight after its clips had rendered -- then
 * marked terminal to free the owner's quota slot -- still holds real clips, and
 * filtering on 'completed' alone deleted it from the user's view while the
 * files sat in storage.
 *
 * Both halves earn their place: a job still in flight is about to rewrite its
 * own clip list, and one that produced nothing has nothing to open.
 */
export async function listProjects(userId: string): Promise<ProjectDTO[]> {
  /**
   * Freshness, for a list that now mixes finished and running work.
   *
   * A running job has no completedAt, so ordering by that column alone dropped
   * every one of them to the bottom -- underneath projects finished weeks ago.
   * Coalescing to createdAt puts the job you just started where you expect it,
   * and it is the same expression the DTO's `createdAt` uses, so the order the
   * server sorts by is the order the client would compute.
   */
  const recency = sql`coalesce(${jobs.completedAt}, ${jobs.createdAt})`

  const rows = await db
    .select()
    .from(jobs)
    .innerJoin(videos, eq(jobs.videoId, videos.id))
    .where(
      and(
        eq(jobs.userId, userId),
        isNull(jobs.deletedAt),
        /**
         * Finished work needs clips to be worth opening; running work does not
         * have any yet. Requiring clips of everything is what kept a job in
         * flight off this screen entirely.
         */
        or(
          not(inArray(jobs.status, [...TERMINAL_STATUSES])),
          exists(db.select({ one: clips.id }).from(clips).where(eq(clips.jobId, jobs.id))),
        ),
      ),
    )
    .orderBy(desc(recency))
    .limit(100)

  return rows.map((r) => ({
    id: r.jobs.id,
    title: r.videos.title,
    source: toSourceDTO(r.videos, r.jobs.clipCount),
    clipCount: r.jobs.clipCount,
    createdAt: (r.jobs.completedAt ?? r.jobs.createdAt).getTime(),
    status: r.jobs.status,
    stage: r.jobs.stage,
    progress: r.jobs.progress,
  }))
}

jobsRoutes.get('/', async (c) => c.json(await listProjects(c.get('user').id)))

/**
 * Delete a project: purge its clips and their S3 objects, then tombstone the row.
 *
 * The row stays because `quotaUsage` counts rows -- a hard delete would refund a
 * daily slot and let anyone reset the cap by clearing their history. The video
 * and transcript rows are deliberately untouched: they are a URL-keyed cache
 * shared between users, and `jobs.video_id` cascades, so deleting a video would
 * take somebody else's jobs with it.
 */
/**
 * Stop a job: flip the row, then pull it from the queue.
 *
 * The row first. The worker checks it between stages, so a job already claimed
 * -- which the queue delete cannot reach -- still stops at the next boundary.
 * One copy, shared by the cancel route, the delete route and
 * backend/scripts/jobs.ts; there used to be one inlined in each route.
 */
export async function cancelJob(jobId: string): Promise<string> {
  // Only cancel if not already terminal (atomic DB check)
  const [row] = await db
    .update(jobs)
    .set({ status: 'cancelled', stage: 'Cancelled', completedAt: new Date() })
    .where(and(eq(jobs.id, jobId), not(inArray(jobs.status, ['completed', 'failed', 'cancelled']))))
    .returning({ id: jobs.id })

  if (!row) {
    const [current] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1)
    return current?.status ?? 'cancelled'
  }

  await boss.deleteJob(PROCESS_QUEUE, jobId).catch(() => {
    // Already claimed by a worker; the status write above is what stops it.
  })

  // Wake up and interrupt any worker currently processing this job
  await pool.query('select pg_notify($1, $2)', [CANCEL_CHANNEL, jobId]).catch(() => {})

  // Emit progress frame only if job is still cancelled (not regenerated to pending mid-flight)
  const [stillCancelled] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'cancelled')))
    .limit(1)

  if (stillCancelled) {
    const payload = encodeProgress({
      jobId,
      status: 'cancelled',
      stage: 'Cancelled',
      progress: 0,
      error: null,
    })
    await pool.query('select pg_notify($1, $2)', [NOTIFY_CHANNEL, payload]).catch(() => {})
  }
  return 'cancelled'
}

export async function softDeleteJob(jobId: string) {
  await deleteJobArtifacts(jobId)
  await db.update(jobs).set({ deletedAt: new Date() }).where(eq(jobs.id, jobId))
}

async function loadJob(userId: string, id: string) {
  const job = await ownedJob(userId, id)
  if (!job) return null

  const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
  if (!video) return null

  const clipRows = await db.select().from(clips).where(eq(clips.jobId, id))
  const renderRows = clipRows.length
    ? await db
        .select()
        .from(renders)
        .where(
          inArray(
            renders.clipId,
            clipRows.map((x) => x.id),
          ),
        )
    : []

  return { job, video, clipRows, renderRows }
}

/**
 * Remove a job's clips and their S3 objects. Called before a regenerate so the
 * old renders do not leak -- the rows cascade, but object storage does not.
 */
export async function deleteJobArtifacts(jobId: string) {
  const clipRows = await db.select().from(clips).where(eq(clips.jobId, jobId))
  if (clipRows.length === 0) return

  const renderRows = await db
    .select()
    .from(renders)
    .where(
      inArray(
        renders.clipId,
        clipRows.map((x) => x.id),
      ),
    )

  // Grouped by the backend each row names, never a flat key list: keys sent to
  // the wrong backend delete nothing and still report success, which would
  // orphan the objects while the database insisted they were gone. A storage
  // hiccup is still survivable -- deleteMany reports and moves on, worst case
  // orphans.
  const objects = renderRows.flatMap((r) =>
    [r.s3Key, r.thumbKey]
      .filter(Boolean)
      .map((key) => ({ storage: r.storage, key: key as string })),
  )

  // The editor proxy and filmstrip hang off the clip rather than a render, and
  // name their own backend for the same reason renders do.
  objects.push(
    ...clipRows.flatMap((c) =>
      [c.proxyKey, c.stripKey]
        .filter(Boolean)
        .map((key) => ({ storage: c.assetStorage, key: key as string })),
    ),
  )

  if (objects.length) await storage.deleteMany(objects)

  await db.delete(clips).where(eq(clips.jobId, jobId))
}
