/**
 * The job pipeline: download -> transcribe -> analyse -> render -> finalize.
 *
 * Every stage boundary re-checks cancellation and reports progress. Expensive
 * intermediate results (the download, the transcript) are keyed to the video
 * rather than the job so a regenerate or a re-cut does not pay for them twice.
 */
import { join } from 'node:path'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { eq, desc, and, not, inArray } from 'drizzle-orm'
import { db, jobs, videos, transcripts, clips, renders, recommendationRounds } from './db.ts'
import { env } from './env.ts'
import { report, setStatus, assertNotCancelled, CancelledError, forgetJob } from './progress.ts'
import { acquireSource, type SourceLease } from './sourceCache.ts'
import { transcribe } from './stages/transcribe.ts'
import { analyze } from './stages/analyze.ts'
import { renderClip } from './stages/render.ts'
import { buildEditorAssets, needingAssets } from './stages/editorAssets.ts'
import { buildSourceAssets } from './stages/sourceAssets.ts'
import { sweepSourceProxies } from './retention.ts'
import { validateRanges, textInRange } from '../../shared/clipRanges.ts'
import { wrapHookLine } from './srt.ts'
import { keys, storage } from './db.ts'
import { RATIOS, RECOMMEND_POOL } from '../../shared/types.ts'
import type { Ratio } from '../../shared/types.ts'
import type { TranscriptSegment } from '../../shared/schema.ts'
import { tryFetchYouTubeSubtitles } from './youtube_subs.ts'
import type { S3 } from '../../shared/s3.ts'

export async function processJob(jobId: string, signal?: AbortSignal): Promise<void> {
  const workDir = join(env.WORK_DIR, jobId)
  // Declared out here so `finally` can give it back on every exit path. A lease
  // that is never released makes its file immortal until this host reboots.
  let lease: SourceLease | null = null

  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    if (!job) throw new Error(`Job ${jobId} no longer exists`)
    if (job.status === 'cancelled' || signal?.aborted) throw new CancelledError()

    const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
    if (!video) throw new Error('Source video row is missing')

    // Resolved once, before the download: a job that has nowhere to put its
    // output should fail in a second rather than after 40 minutes of work. One
    // backend per job also means flipping the active target mid-render leaves
    // this job whole instead of scattered across two buckets.
    const store = await storage.active()

    await assertNotCancelled(jobId, signal)
    await setStatus(jobId, {
      status: 'downloading',
      stage: 'Starting',
      progress: 0,
      error: null,
      startedAt: new Date(),
    })

    await mkdir(workDir, { recursive: true })

    // --- 1. download ---------------------------------------------------------
    await assertNotCancelled(jobId, signal)
    // Held for the whole job: everything below reads this file, and the sweep
    // must not take it away mid-render. Released in `finally`
    lease = await acquireSource(jobId, video, { signal })
    const sourcePath = lease.path

    // --- 2. transcribe -------------------------------------------------------
    await assertNotCancelled(jobId, signal)
    const segments = await ensureTranscript(
      jobId,
      video.id,
      video.url,
      sourcePath,
      video.durationSeconds,
      workDir,
      store,
      signal,
    )

    // --- 3. analyse ----------------------------------------------------------
    await assertNotCancelled(jobId, signal)
    /**
     * ponytail: the bar cannot move during the model call -- the provider
     * streams no progress, and inventing a creeping percentage would be a lie
     * told to the one person who cannot check it. So the stage announces what
     * it is doing and holds, and only moves on work actually finished.
     *
     * Upgrade path: if the provider ever reports token progress, or analyze()
     * is split into per-chunk calls, feed the fraction through report() here.
     */
    await setStatus(jobId, { status: 'analyzing', stage: 'Scoring moments', progress: 48 })

    /**
     * Enough for the clips AND the opening recommendation list.
     *
     * The prompt asks for ~1.8x this, because validation drops overlaps and
     * out-of-window ranges. At clipCount alone the surplus after dropOverlaps
     * is two or three moments -- too thin a list to open with. Asking wider
     * costs a few more objects in one response, against a transcript that is
     * already thousands of lines.
     *
     * Not conditional on the recommendations flag: that lives in the API's env,
     * the worker has no view of it, and rows nobody reads are cheaper than a
     * third copy of one switch.
     */
    const wanted = job.clipCount + RECOMMEND_POOL

    const candidates = await analyze({
      segments,
      durationSeconds: video.durationSeconds,
      lengthIdx: job.lengthPreset,
      count: wanted,
      title: video.title,
      // Read off the job row, which is why regenerate honours the brief without
      // knowing it exists: it re-runs this same row.
      brief: job.prompt,
      signal,
    })

    // The scoring is the long half of this stage; validation is fast. Moving
    // here proves the model answered rather than hung.
    await report(jobId, 'analyzing', 'Choosing clips', 0.7)

    /**
     * Rank everything that survives validation, not just what becomes a clip.
     *
     * The model is asked for more candidates than the user wants because
     * validation drops overlaps and out-of-window ranges, so a request for
     * exactly `count` under-delivers. Whatever is left over used to be
     * discarded by the .slice() inside validateRanges. It is the same fully
     * validated output as the clips -- clamped, snapped to speech boundaries,
     * fitted to the length window -- so it is worth keeping as the opening
     * recommendation list, and keeping it costs one insert and no model call.
     *
     * Asking for a bigger `count` rather than changing validateRanges keeps its
     * contract intact: clamp, snap, fit, drop overlaps, take the best N.
     */
    const ranked = validateRanges(candidates, {
      durationSeconds: video.durationSeconds,
      lengthIdx: job.lengthPreset,
      count: wanted,
      segments,
    })

    const ranges = ranked.slice(0, job.clipCount)
    const surplus = ranked.slice(job.clipCount)

    if (ranges.length === 0) {
      throw new Error(
        'No usable moments were found in that video. Try a different clip length, or a source with more speech.',
      )
    }

    // Replace any previous clips (a regenerate re-enters here).
    await db.delete(clips).where(eq(clips.jobId, jobId))

    /**
     * The same applies to the conversation: a regenerate has just re-picked
     * every clip, so rounds that avoided the OLD ones are advice about a list
     * that no longer exists.
     */
    await db.delete(recommendationRounds).where(eq(recommendationRounds.jobId, jobId))

    if (surplus.length > 0) {
      // userMessage NULL: nobody asked for this round, it fell out of the
      // analysis. The UI reads that as "no chat bubble to draw".
      await db.insert(recommendationRounds).values({ jobId, userMessage: null, candidates: surplus })
    }

    const clipRows = await db
      .insert(clips)
      .values(
        ranges.map((r, i) => ({
          jobId,
          idx: i,
          title: r.title,
          startSeconds: r.start,
          endSeconds: r.end,
          score: r.score,
          snippet: r.snippet || textInRange(segments, r.start, r.end).slice(0, 220),
          caption: r.caption || r.title,
          subtitleLine: wrapHookLine(r.line || r.title),
          status: 'pending' as const,
        })),
      )
      .returning()

    await setStatus(jobId, {
      status: 'rendering',
      stage: `Rendering 0 of ${clipRows.length}`,
      progress: 60,
    })

    // --- 4. render -----------------------------------------------------------
    const ratios = RATIOS.filter((r) => (job.formats as Record<string, boolean>)[r])
    for (const [i, clip] of clipRows.entries()) {
      await assertNotCancelled(jobId, signal)
      await report(jobId, 'rendering', `Rendering ${i + 1} of ${clipRows.length}`, i / clipRows.length)

      await renderClip({
        jobId,
        clip,
        sourcePath,
        workDir,
        ratios,
        segments,
        burnSubtitles: job.burnSubtitles,
        store,
        signal,
      })

      await storeEditorAssets(clip, sourcePath, workDir, video.durationSeconds, store, signal)
    }

    // --- 5. finalize ---------------------------------------------------------
    await assertNotCancelled(jobId, signal)
    await setStatus(jobId, { status: 'rendering', stage: 'Cleaning up', progress: 96 })
    await rm(workDir, { recursive: true, force: true }).catch(() => {})

    await assertNotCancelled(jobId, signal)
    if (signal?.aborted) throw new CancelledError()
    await setStatus(jobId, {
      status: 'completed',
      stage: 'Done',
      progress: 100,
      error: null,
      completedAt: new Date(),
    })
  } catch (e) {
    // Scratch is deleted on every exit path. Leaving the intermediate renders
    // behind after a failure is how free disk disappears in three attempts.
    // (The source itself is not in here any more -- it is leased, and released
    // in `finally` for the sweep to reclaim on its own schedule.)
    await rm(workDir, { recursive: true, force: true }).catch(() => {})

    if (e instanceof CancelledError || signal?.aborted || (e as Error)?.name === 'AbortError') {
      // Atomic update: only set cancelled if row is currently in a cancellable state
      // (not pending, which means regenerate() was called)
      await db
        .update(jobs)
        .set({
          status: 'cancelled',
          stage: 'Cancelled',
          completedAt: new Date(),
        })
        .where(
          and(
            eq(jobs.id, jobId),
            not(inArray(jobs.status, ['completed', 'pending', 'cancelled'])),
          ),
        )
        .catch(() => {})
      return
    }

    const message = (e as Error).message ?? 'Unknown error'
    console.error(`[pipeline] job ${jobId} failed:`, message)
    await setStatus(jobId, {
      status: 'failed',
      stage: 'Failed',
      error: message.slice(0, 1000),
      completedAt: new Date(),
    }).catch(() => {})
  } finally {
    await lease?.release()
    forgetJob(jobId)
  }
}

/** Reuse an existing transcript for this video; otherwise produce one. */
async function ensureTranscript(
  jobId: string,
  videoId: string,
  videoUrl: string,
  sourcePath: string,
  durationSeconds: number,
  workDir: string,
  store: { id: string; s3: S3 },
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const [existing] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.videoId, videoId))
    .orderBy(desc(transcripts.createdAt))
    .limit(1)

  if (existing && existing.segments.length > 0) {
    await report(jobId, 'transcribing', 'Using cached transcript', 1)
    return existing.segments
  }

  await setStatus(jobId, { status: 'transcribing', stage: 'Transcribing', progress: 24 })

  // 1. Try fetching auto-captions / subtitles directly (if enabled, instant & high accuracy)
  /**
   * Name the fetch, because it is not instant on a long video and it reports
   * nothing while it runs. Without this the bar sat at 24% under the word
   * "Transcribing" for the whole fetch, which reads identically to a stall.
   */
  if (env.PREFER_YOUTUBE_SUBTITLES) {
    await report(jobId, 'transcribing', 'Fetching captions', 0)
  }
  let result = env.PREFER_YOUTUBE_SUBTITLES
    ? await tryFetchYouTubeSubtitles(videoUrl, workDir, `[pipeline ${jobId}]`, signal)
    : null

  // Captions arrive whole rather than progressively, so this is the only
  // honest place to move the bar for that path: it is done.
  if (result) await report(jobId, 'transcribing', 'Captions ready', 1)

  // 2. Fallback to local Whisper if subtitles are unavailable
  if (!result) {
    result = await transcribe(sourcePath, workDir, durationSeconds, (f) => {
      void report(jobId, 'transcribing', 'Transcribing', f)
    }, signal)
  }

  let srtKey: string | null = null
  if (result.srt.trim()) {
    srtKey = keys.srt(videoId)
    await store.s3
      .upload(srtKey, Buffer.from(result.srt, 'utf8'), 'application/x-subrip')
      .catch((e: Error) => {
      // The sidecar SRT is a convenience; losing it must not fail the job.
        console.warn('[pipeline] could not upload transcript SRT:', e.message)
        srtKey = null
      })
  }

  await db.insert(transcripts).values({
    videoId,
    language: result.language,
    srtKey,
    // Written with the key, so the two can never disagree about where it is.
    storage: store.id,
    segments: result.segments,
  })

  return result.segments
}

/**
 * Build and store the editor's proxy, filmstrip and waveform for one clip.
 *
 * Best effort, by design. These exist so the editor screen has something to
 * play; losing them costs a placeholder and a note, and failing a forty-minute
 * render over a filmstrip would be absurd. The same posture the sidecar SRT
 * upload takes.
 */
async function storeEditorAssets(
  clip: typeof clips.$inferSelect,
  sourcePath: string,
  workDir: string,
  durationSeconds: number,
  store: { id: string; s3: S3 },
  signal?: AbortSignal,
): Promise<void> {
  try {
    const built = await buildEditorAssets({
      sourcePath,
      workDir,
      stem: `clip-${clip.idx}`,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      durationSeconds,
      signal,
    })

    const proxyKey = keys.proxy(clip.jobId, clip.id)
    const stripKey = keys.strip(clip.jobId, clip.id)

    const [mp4, jpg] = await Promise.all([
      readFile(built.proxyPath),
      readFile(built.stripPath),
    ])

    await Promise.all([
      store.s3.upload(proxyKey, mp4, 'video/mp4'),
      store.s3.upload(stripKey, jpg, 'image/jpeg'),
    ])

    await db
      .update(clips)
      .set({
        proxyKey,
        // The Range header the editor's scrubber depends on needs a length, and
        // the storage interface has no HEAD -- so record it here, at the one
        // moment the size is known for free.
        proxyBytes: mp4.byteLength,
        stripKey,
        peaks: built.peaks,
        windowStart: built.window.start,
        windowSpan: built.window.span,
        // Written with the keys, so the two can never disagree about where they are.
        assetStorage: store.id,
      })
      .where(eq(clips.id, clip.id))

    await Promise.all([
      rm(built.proxyPath, { force: true }).catch(() => {}),
      rm(built.stripPath, { force: true }).catch(() => {}),
    ])
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
    console.warn(`[pipeline] editor assets for clip ${clip.id} failed:`, (e as Error).message)
  }
}

/**
 * Build editor assets for a finished job's clips, without re-rendering them.
 *
 * Exists because a clip cut before the editor had a proxy has nothing to play,
 * and re-cutting one to get a preview would re-encode every ratio of a video
 * that was already correct.
 *
 * Per job, not per clip: the expensive part is the source download, and twelve
 * clips of one video must not mean twelve downloads of it.
 */
export async function backfillAssets(jobId: string): Promise<void> {
  const workDir = join(env.WORK_DIR, `assets-${jobId}`)
  // Captured out here so the cleanup in `finally` can null the scratch path it
  // claimed, on the failure paths as well as the happy one.
  let lease: SourceLease | null = null

  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    if (!job) throw new Error('Job no longer exists')

    const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
    if (!video) throw new Error('Source video row is missing')

    const pending = needingAssets(await db.select().from(clips).where(eq(clips.jobId, jobId)))
    if (pending.length === 0) return

    const store = await storage.active()
    await mkdir(workDir, { recursive: true })
    // Quiet: this job finished long ago and must not be dragged back into
    // 'downloading' just because somebody opened its editor.
    lease = await acquireSource(jobId, video, { quiet: true })
    const sourcePath = lease.path

    for (const clip of pending) {
      await storeEditorAssets(clip, sourcePath, workDir, video.durationSeconds, store)
    }

    console.log(`[pipeline] backfilled assets for ${pending.length} clip(s) of job ${jobId}`)
  } catch (e) {
    // Nowhere to report this: the job's own status belongs to its render, and
    // failing a preview must not make a finished project look broken. The
    // editor falls back to the rendered clip and says the preview is limited.
    console.error(`[pipeline] asset backfill for job ${jobId} failed:`, (e as Error).message)
  } finally {
    // Scratch goes on every exit path, as everywhere else in this file. The
    // source is not in it -- that is leased, and released here so the sweep can
    // reclaim it once nothing is reading it.
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    await lease?.release()
  }
}

/**
 * Re-cut one clip: re-render the existing range from a freshly downloaded
 * source. Reuses the transcript, so this costs a download plus one render
 * rather than a full re-analysis.
 */
export async function recutClip(jobId: string, clipId: string): Promise<void> {
  const workDir = join(env.WORK_DIR, `recut-${clipId}`)
  let lease: SourceLease | null = null

  try {
    const [clip] = await db.select().from(clips).where(eq(clips.id, clipId)).limit(1)
    if (!clip) throw new Error('Clip no longer exists')

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
    if (!job) throw new Error('Job no longer exists')

    const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
    if (!video) throw new Error('Source video row is missing')

    const [transcript] = await db
      .select()
      .from(transcripts)
      .where(eq(transcripts.videoId, video.id))
      .orderBy(desc(transcripts.createdAt))
      .limit(1)

    if (!transcript) throw new Error('No transcript for this video; regenerate the job instead.')

    const store = await storage.active()

    await mkdir(workDir, { recursive: true })
    /**
     * Quiet: this job is already 'completed' and must stay that way.
     *
     * This is the call the whole shared cache exists for. A re-cut follows a
     * saved trim, which follows opening the editor -- and opening the editor
     * downloaded this exact file minutes ago to build the source proxy. Before
     * the cache it was in another operation's scratch directory and therefore
     * unreadable, so this re-downloaded gigabytes it already had.
     */
    lease = await acquireSource(jobId, video, { quiet: true })
    const sourcePath = lease.path

    // Drop the previous renders, in storage as well as in the database. Each row
    // carries its own backend: an old render may predate the current write
    // target, and aiming its keys at the wrong bucket would delete nothing while
    // reporting success.
    const old = await db.select().from(renders).where(eq(renders.clipId, clipId))
    const objects = old.flatMap((r) =>
      [r.s3Key, r.thumbKey].filter(Boolean).map((key) => ({ storage: r.storage, key: key as string })),
    )
    // The editor assets go too. A re-cut usually follows a saved trim, which
    // moves clip.startSeconds and therefore moves the window they cover, so
    // keeping them would leave the editor scrubbing the wrong stretch of source.
    objects.push(
      ...[clip.proxyKey, clip.stripKey]
        .filter(Boolean)
        .map((key) => ({ storage: clip.assetStorage, key: key as string })),
    )
    if (objects.length) await storage.deleteMany(objects)
    await db.delete(renders).where(eq(renders.clipId, clipId))

    await renderClip({
      jobId,
      clip,
      sourcePath,
      workDir,
      ratios: RATIOS.filter((r) => (job.formats as Record<string, boolean>)[r]) as Ratio[],
      segments: transcript.segments,
      burnSubtitles: job.burnSubtitles,
      store,
    })

    await storeEditorAssets(clip, sourcePath, workDir, video.durationSeconds, store)
  } catch (e) {
    const message = (e as Error).message ?? 'Unknown error'
    console.error(`[pipeline] recut ${clipId} failed:`, message)
    await db
      .update(clips)
      .set({ status: 'failed', error: message.slice(0, 500) })
      .where(eq(clips.id, clipId))
      .catch(() => {})
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    await lease?.release()
  }
}

/**
 * Build the full-length editor assets for one source video.
 *
 * Per video, not per job: `videos` rows are deduplicated by URL, so two users
 * editing the same source share these -- and share the one download that makes
 * them. The queue's singleton key is the video id for that reason.
 *
 * Best effort, like the backfill. A project whose source has been pulled from
 * YouTube must not start looking broken because somebody opened manual mode.
 */
export async function buildSourceProxy(videoId: string, jobId: string): Promise<void> {
  const workDir = join(env.WORK_DIR, `source-${videoId}`)
  let lease: SourceLease | null = null

  try {
    const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1)
    if (!video) throw new Error('Source video row is missing')

    // Another build may have won the race while this one sat in the queue.
    // Touch it so the winner is not evicted for looking idle, and stop.
    if (video.proxyKey) {
      await db.update(videos).set({ proxyUsedAt: new Date() }).where(eq(videos.id, videoId))
      return
    }

    if (video.durationSeconds <= 0) throw new Error('Source has no duration to scrub')

    const store = await storage.active()
    await mkdir(workDir, { recursive: true })
    // Quiet: whichever job asked for this finished long ago, and dragging it
    // back into 'downloading' would make every write path refuse it. Null job
    // id for the same reason: this build belongs to a video, not a project.
    lease = await acquireSource(null, video, { quiet: true })
    const sourcePath = lease.path

    const built = await buildSourceAssets({
      sourcePath,
      workDir,
      durationSeconds: video.durationSeconds,
    })

    const proxyKey = keys.sourceProxy(videoId)
    const stripKey = keys.sourceStrip(videoId)
    const [proxy, strip] = await Promise.all([
      readFile(built.proxyPath),
      readFile(built.stripPath),
    ])

    await Promise.all([
      store.s3.upload(proxyKey, proxy, 'video/mp4'),
      store.s3.upload(stripKey, strip, 'image/jpeg'),
    ])

    await db
      .update(videos)
      .set({
        proxyKey,
        stripKey,
        peaks: built.peaks,
        assetStorage: store.id,
        proxyBytes: proxy.byteLength + strip.byteLength,
        // Stamped on write as well as on read, so a build that nobody opens
        // still ages from the moment it existed rather than from never.
        proxyUsedAt: new Date(),
      })
      .where(eq(videos.id, videoId))

    console.log(
      `[pipeline] built source assets for video ${videoId} ` +
        `(${Math.round((proxy.byteLength + strip.byteLength) / 1024 / 1024)}MB), job ${jobId}`,
    )
  } catch (e) {
    // Nowhere to report this: the job's status belongs to its render, and a
    // failed preview must not make a finished project look broken.
    console.error(`[pipeline] source assets for video ${videoId} failed:`, (e as Error).message)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    /**
     * Released BEFORE the sweep below, not after. This build is usually
     * followed within minutes by the re-cut that saves a trim, so the file
     * stays cached -- but holding the lease across the sweep would make the
     * source structurally un-evictable exactly when the disk is tightest.
     */
    await lease?.release()
  }

  /**
   * After the build, never before: whatever was just written is the most
   * recently used thing there is, so it cannot evict itself to make room for
   * itself. Outside the try/catch because a failed build is exactly when the
   * disk is most likely to need the sweep.
   */
  await sweepSourceProxies().catch((e) => {
    console.error('[retention] sweep failed:', (e as Error).message)
  })
}
