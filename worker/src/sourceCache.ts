/**
 * Leases on cached original downloads.
 *
 * The problem: opening the editor downloads the source to build a proxy, and
 * saving a trim minutes later needs the same file. Those run as two different
 * operations in two different scratch directories, and every operation deletes
 * its own directory on the way out -- so the second re-downloaded several
 * gigabytes it already had.
 *
 * Reusing the first operation's file directly is the race this replaces: a
 * re-cut that adopted a running job's scratch download lost it the moment that
 * job finished and cleaned up, failing mid-render on a file it never created.
 *
 * So the download moves OUT of any operation's directory. It lands in
 * WORK_DIR/sources/<videoId>/, which nothing cleans up on exit and only the
 * sweep in retention.ts deletes. Relocating one file is the whole of the fix;
 * the ref counting below exists to bound and reclaim it safely.
 *
 * THE FILE IS SHARED, SO THE RULES ARE:
 *
 *   - Take a lease before reading it, release it in a `finally`.
 *   - A row with refs != 0 is never deleted, at any size, by any rule.
 *   - Increment and decrement in SQL, never read-modify-write: the four
 *     boss.work registrations poll independently, so two operations really can
 *     hold one source at once.
 *   - Reuse requires the file to EXIST as well as the row to match this host.
 *     That is what makes a wrong WORKER_HOST_ID cost a re-download rather than
 *     a render failing on a missing path.
 */
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { mkdir, rename, rm, readdir, stat, access, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { eq, and, sql } from 'drizzle-orm'
import { db, videos, videoSourceCache, storage, keys } from './db.ts'
import { env } from './env.ts'
import { download, probe, assertDiskSpace, assertYtdlpFresh } from '../../shared/ytdlp.ts'
import { report, setStatus } from './progress.ts'
import { sweepSources } from './retention.ts'

/** Everything cached lives here. Outside any operation's workDir, on purpose. */
export const sourcesDir = () => join(env.WORK_DIR, 'sources')

/**
 * Where a completed download lives, and where one still arriving lives.
 *
 * Per-video subdirectory rather than a flat one because download() hardcodes
 * its output template as `${outDir}/source.%(ext)s` -- two different videos
 * downloading into one directory would collide on the same filename.
 */
const finalDir = (videoId: string) => join(sourcesDir(), videoId)
const partialDir = (videoId: string) => join(sourcesDir(), `${videoId}.partial`)

/** A held source. Release it in a `finally`, or its file becomes immortal. */
export interface SourceLease {
  path: string
  release: () => Promise<void>
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Hand back a lease, in a form that cannot be released twice by accident.
 *
 * Double release is guarded in SQL as well (`refs > 0`), but a local flag means
 * the common case never reaches the database twice.
 */
function lease(videoId: string, path: string): SourceLease {
  let released = false
  return {
    path,
    release: async () => {
      if (released) return
      released = true
      await releaseSource(videoId)
      /**
       * Reclaim on the way out, rather than waiting for the next boot. With an
       * 8GB ceiling and multi-gigabyte files, one finished job can put the
       * cache over budget on its own, and the next download is usually minutes
       * away. Caught, because a sweep must never fail the operation that has
       * already succeeded.
       */
      await sweepSources().catch((e: Error) => {
        console.error('[sources] post-release sweep failed:', e.message)
      })
    },
  }
}

/**
 * Take a lease on this video's source, downloading it first if we have to.
 *
 * `jobId` stays nullable and `quiet` keeps the meaning ensureDownloaded gave
 * them: a re-cut and a backfill both run against a job that is already
 * 'completed', and announcing 'downloading' would take it out of that state.
 * Only the announcement is suppressed; the download and its disk guards are
 * unchanged.
 */
export async function acquireSource(
  jobId: string | null,
  video: typeof videos.$inferSelect,
  opts: { quiet?: boolean } = {},
): Promise<SourceLease> {
  const announce = async (stage: string, fraction: number) => {
    if (opts.quiet || !jobId) return
    await report(jobId, 'downloading', stage, fraction)
  }

  // Claim first, ask questions second. Incrementing before checking the file
  // means a sweep running concurrently sees the row as held and leaves it
  // alone; checking first would leave a window where it could be deleted
  // between the check and the claim.
  const [claimed] = await db
    .update(videoSourceCache)
    .set({ refs: sql`${videoSourceCache.refs} + 1`, usedAt: new Date() })
    .where(
      and(
        eq(videoSourceCache.videoId, video.id),
        eq(videoSourceCache.hostId, env.WORKER_HOST_ID),
      ),
    )
    .returning({ path: videoSourceCache.path })

  if (claimed) {
    if (await fileExists(claimed.path)) {
      await announce('Using cached download', 1)
      return lease(video.id, claimed.path)
    }
    /**
     * The row outlived its file: a wiped volume, or somebody clearing the disk
     * by hand. Drop the row, which discards the increment with it, and fall
     * through to download. Self-healing, so no boot reconcile is needed.
     */
    await db
      .delete(videoSourceCache)
      .where(
        and(
          eq(videoSourceCache.videoId, video.id),
          eq(videoSourceCache.hostId, env.WORKER_HOST_ID),
        ),
      )
    console.warn(`[sources] ${claimed.path} is gone; re-downloading ${video.id}`)
  }

  // Check if source exists in S3 (e.g. downloaded by another worker)
  try {
    const store = await storage.active()
    const s3Key = keys.sourceVideo(video.id)
    if (await store.s3.exists(s3Key)) {
      await announce('Fetching source from storage', 0.5)
      const home = finalDir(video.id)
      await mkdir(home, { recursive: true })
      const localPath = join(home, 'source.mp4')
      const stream = await store.s3.getStream(s3Key)
      await pipeline(stream, createWriteStream(localPath))
      const { size } = await stat(localPath)

      await db
        .insert(videoSourceCache)
        .values({
          videoId: video.id,
          hostId: env.WORKER_HOST_ID,
          path: localPath,
          bytes: size,
          usedAt: new Date(),
          refs: 1,
        })
        .onConflictDoUpdate({
          target: [videoSourceCache.videoId, videoSourceCache.hostId],
          set: {
            path: localPath,
            bytes: size,
            usedAt: new Date(),
            refs: sql`${videoSourceCache.refs} + 1`,
          },
        })

      await announce('Using cached source from storage', 1)
      return lease(video.id, localPath)
    }
  } catch (e) {
    console.warn(`[sources] check S3 source cache failed for ${video.id}:`, (e as Error).message)
  }

  return downloadAndClaim(jobId, video, announce)
}

async function downloadAndClaim(
  jobId: string | null,
  video: typeof videos.$inferSelect,
  announce: (stage: string, fraction: number) => Promise<void>,
): Promise<SourceLease> {
  /**
   * Make room BEFORE asking whether there is room.
   *
   * Without this the budget only tidies up after the fact, and the cache would
   * cause the disk-full failures it is meant to absorb: eight gigabytes of
   * last hour's sources sitting there while this download fails the guard.
   */
  await sweepSources().catch((e: Error) => {
    console.error('[sources] pre-download sweep failed:', e.message)
  })

  await assertYtdlpFresh(env.YTDLP_MAX_AGE_DAYS)

  // Re-probe for a current size estimate: the disk guard is only useful with a
  // number, and the stored row may predate the current format availability.
  const info = await probe(video.url).catch(() => null)
  await assertDiskSpace(env.WORK_DIR, info?.estimatedBytes ?? null, env.MIN_FREE_DISK_GB)

  if (jobId) {
    await setStatus(jobId, { status: 'downloading', stage: 'Downloading source', progress: 0 })
  }

  /**
   * Download to `<id>.partial/`, then rename the directory.
   *
   * download() passes --no-part, so yt-dlp writes straight to the final name
   * with no temporary suffix of its own: a worker killed mid-download leaves a
   * TRUNCATED source.mp4 that looks complete. Harmless when the directory was
   * deleted on the way out; fatal for a shared cache, where the next operation
   * would reuse it and fail somewhere deep in ffmpeg.
   *
   * Renaming a directory is atomic within one filesystem, and the row is
   * written only afterwards, so nobody can observe a partial download as
   * cacheable.
   */
  const staging = partialDir(video.id)
  const home = finalDir(video.id)

  await rm(staging, { recursive: true, force: true }).catch(() => {})
  await mkdir(staging, { recursive: true })

  let path: string
  try {
    const downloaded = await download(video.url, staging, (f) => {
      void announce('Downloading source', f)
    })
    // Whatever survived a previous run under the final name goes: rename onto
    // an existing directory fails, and that file is superseded regardless.
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rename(staging, home)
    // Same filename, new directory: download() reported it inside `staging`,
    // which we have just renamed to `home`.
    path = join(home, basename(downloaded))
  } catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw e
  }

  const { size } = await stat(path)

  // Upload to S3 so any other worker can reuse this source without re-downloading from YouTube
  try {
    const store = await storage.active()
    const s3Key = keys.sourceVideo(video.id)
    const fileBuf = await readFile(path)
    await store.s3.upload(s3Key, fileBuf, 'video/mp4')
  } catch (e) {
    console.warn(`[sources] S3 upload failed for ${video.id}:`, (e as Error).message)
  }

  await db
    .insert(videoSourceCache)
    .values({
      videoId: video.id,
      hostId: env.WORKER_HOST_ID,
      path,
      bytes: size,
      usedAt: new Date(),
      refs: 1,
    })
    .onConflictDoUpdate({
      target: [videoSourceCache.videoId, videoSourceCache.hostId],
      set: {
        path,
        bytes: size,
        usedAt: new Date(),
        // Not 1: another operation may have taken a lease on the row we just
        // replaced, and overwriting its count would let the sweep delete the
        // file out from under it.
        refs: sql`${videoSourceCache.refs} + 1`,
      },
    })

  return lease(video.id, path)
}

/**
 * Give back one lease.
 *
 * `refs > 0` stops a decrement that ran without its increment driving the count
 * negative. Belt and braces: sourceEvictionPlan reads ANY non-zero value as in
 * use, so a drifted count fails toward keeping the file either way.
 */
async function releaseSource(videoId: string): Promise<void> {
  await db
    .update(videoSourceCache)
    .set({ refs: sql`${videoSourceCache.refs} - 1`, usedAt: new Date() })
    .where(
      and(
        eq(videoSourceCache.videoId, videoId),
        eq(videoSourceCache.hostId, env.WORKER_HOST_ID),
        sql`${videoSourceCache.refs} > 0`,
      ),
    )
    .catch((e: Error) => {
      // Never fail the operation that just succeeded over its own bookkeeping.
      // A leaked count costs disk until this host's next boot, which zeroes it.
      console.error(`[sources] could not release ${videoId}:`, e.message)
    })
}

/**
 * Reclaim this host's leases and debris. Runs at startup, before any work is
 * claimed.
 *
 * ZEROING REFS IS SAFE HERE AND NOWHERE ELSE, for the reason reconcileOnBoot
 * gives for the same move on `jobs`: a booting worker holds no leases, so any
 * row still claiming otherwise was abandoned by a dead process. Scoped to this
 * host's rows -- another machine's leases are live and none of our business.
 */
export async function reclaimSourceLeases(): Promise<{ leases: number; partials: number }> {
  const reset = await db
    .update(videoSourceCache)
    .set({ refs: 0 })
    .where(
      and(eq(videoSourceCache.hostId, env.WORKER_HOST_ID), sql`${videoSourceCache.refs} <> 0`),
    )
    .returning({ videoId: videoSourceCache.videoId })

  // Directories from a download killed in flight. No row ever pointed at them,
  // so the sweep cannot find them and they would sit there until the disk
  // filled.
  let partials = 0
  const entries = await readdir(sourcesDir(), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.partial')) continue
    await rm(join(sourcesDir(), entry.name), { recursive: true, force: true }).catch(() => {})
    partials++
  }

  return { leases: reset.length, partials }
}
