/**
 * Cut, reframe, burn subtitles, thumbnail, upload.
 *
 * Speaker-tracking reframe runs through the vendored autocrop.py (MediaPipe).
 * When it is unavailable or fails on a given clip we fall back to a static
 * centre crop rather than failing the job -- a centred clip is worth more to
 * the user than no clip.
 */
import { join } from 'node:path'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db, clips, renders, keys } from '../db.ts'
import { run, exists } from '../../../shared/proc.ts'
import { RATIO_DIMS } from '../../../shared/types.ts'
import type { Ratio } from '../../../shared/types.ts'
import type { TranscriptSegment, Clip } from '../../../shared/schema.ts'
import type { S3 } from '../../../shared/s3.ts'
import { cutAccurate, thumbnail, reframeStatic, probeDimensions } from '../ffmpeg.ts'
import { buildClipAss } from '../ass.ts'

const AUTOCROP = new URL('../../python/autocrop.py', import.meta.url).pathname

let autocropChecked: boolean | null = null

/** Is speaker-tracking reframe usable? Checked once per process. */
async function autocropAvailable(): Promise<boolean> {
  if (autocropChecked !== null) return autocropChecked
  try {
    if (!(await exists('python3'))) throw new Error('no python3')
    // Importing mediapipe is the real test; the script exits non-zero without it.
    await run(['python3', '-c', 'import mediapipe, numpy'], { timeoutMs: 60_000 })
    autocropChecked = true
  } catch {
    console.warn('[render] mediapipe unavailable -- falling back to static centre crop')
    autocropChecked = false
  }
  return autocropChecked
}

export interface RenderClipOptions {
  jobId: string
  clip: Clip
  sourcePath: string
  workDir: string
  ratios: Ratio[]
  /**
   * Where this job's output goes. Resolved once by processJob rather than per
   * clip, so one job lands entirely in one backend even if the active target is
   * flipped while it runs.
   */
  store: { id: string; s3: S3 }
  segments: TranscriptSegment[]
  burnSubtitles: boolean
  signal?: AbortSignal
}

/** Render every requested ratio for one clip and upload the results. */
export async function renderClip(opts: RenderClipOptions): Promise<void> {
  const { clip, workDir } = opts
  const duration = clip.endSeconds - clip.startSeconds
  const stem = `clip-${clip.idx}`
  const cutPath = join(workDir, `${stem}.mp4`)

  await db.update(clips).set({ status: 'rendering' }).where(eq(clips.id, clip.id))

  // Re-encode rather than stream-copy: a copy can only cut on keyframes, and a
  // boundary that drifts a second or two cuts off the hook, which is the whole
  // point of the clip.
  await cutAccurate(opts.sourcePath, cutPath, clip.startSeconds, duration, opts.signal)

  // One subtitle file per ratio, not per clip: the ASS header declares the
  // output resolution, which is what keeps font sizes in output pixels.
  const subPaths: string[] = []

  const useAutocrop = await autocropAvailable()
  let anySucceeded = false

  for (const ratio of opts.ratios) {
    const dims = RATIO_DIMS[ratio]
    const outPath = join(workDir, `${stem}-${ratio.replace(':', 'x')}.mp4`)
    const thumbPath = join(workDir, `${stem}-${ratio.replace(':', 'x')}.jpg`)

    const [renderRow] = await db
      .insert(renders)
      .values({ clipId: clip.id, ratio, status: 'rendering' })
      .returning()

    try {
      let subPath: string | undefined
      if (opts.burnSubtitles) {
        const ass = buildClipAss(
          opts.segments,
          clip.startSeconds,
          clip.endSeconds,
          dims.w,
          dims.h,
        )
        if (ass) {
          subPath = join(workDir, `${stem}-${ratio.replace(':', 'x')}.ass`)
          await writeFile(subPath, ass, 'utf8')
          subPaths.push(subPath)
        }
      }

      if (useAutocrop) {
        try {
          await runAutocrop(cutPath, outPath, dims, subPath, opts.signal)
        } catch (e) {
          if (opts.signal?.aborted) throw e
          console.warn(
            `[render] autocrop failed for clip ${clip.idx} ${ratio}, ` +
              `using centre crop: ${(e as Error).message}`,
          )
          await reframeStatic(cutPath, outPath, dims.w, dims.h, subPath, opts.signal)
        }
      } else {
        await reframeStatic(cutPath, outPath, dims.w, dims.h, subPath, opts.signal)
      }

      await thumbnail(outPath, thumbPath, Math.min(1, duration / 2), opts.signal)

      const [mp4, jpg] = await Promise.all([readFile(outPath), readFile(thumbPath)])
      const s3Key = keys.render(opts.jobId, clip.id, ratio)
      const thumbKey = keys.thumb(opts.jobId, clip.id, ratio)

      await Promise.all([
        opts.store.s3.upload(s3Key, mp4, 'video/mp4'),
        opts.store.s3.upload(thumbKey, jpg, 'image/jpeg'),
      ])

      const actual = await probeDimensions(outPath).catch(() => ({
        width: dims.w,
        height: dims.h,
      }))

      await db
        .update(renders)
        .set({
          s3Key,
          thumbKey,
          // Written in the same statement as the keys it describes: a key and
          // its location must never be able to disagree.
          storage: opts.store.id,
          width: actual.width,
          height: actual.height,
          sizeBytes: mp4.byteLength,
          durationSeconds: duration,
          status: 'ready',
        })
        .where(eq(renders.id, renderRow.id))

      anySucceeded = true

      // Local copies are uploaded; free the disk before the next ratio.
      await Promise.all([unlink(outPath).catch(() => {}), unlink(thumbPath).catch(() => {})])
    } catch (e) {
      if (opts.signal?.aborted || (e as Error)?.name === 'AbortError') {
        throw e
      }
      const message = (e as Error).message.slice(0, 500)
      console.error(`[render] clip ${clip.idx} ${ratio} failed:`, message)
      await db
        .update(renders)
        .set({ status: 'failed', error: message })
        .where(eq(renders.id, renderRow.id))
    }
  }

  await Promise.all([
    unlink(cutPath).catch(() => {}),
    ...subPaths.map((p) => unlink(p).catch(() => {})),
  ])

  await db
    .update(clips)
    .set({
      status: anySucceeded ? 'ready' : 'failed',
      error: anySucceeded ? null : 'Every requested format failed to render.',
    })
    .where(eq(clips.id, clip.id))
}

/**
 * ponytail: autocrop re-runs MediaPipe analysis for every ratio, so a
 * three-format clip pays the face-tracking cost three times. Splitting
 * autocrop.py into analyse-once / render-N would cut roughly 2/3 of the
 * tracking time -- worth doing if render wall-clock becomes the complaint.
 */
async function runAutocrop(
  input: string,
  output: string,
  dims: { w: number; h: number },
  subtitlePath?: string,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    'python3',
    AUTOCROP,
    input,
    '--out-file',
    output,
    '--out-w',
    String(dims.w),
    '--out-h',
    String(dims.h),
  ]
  // No --sub-style: the ASS file carries its own styling, declared against the
  // output resolution. A force_style here would be read in PlayRes space.
  if (subtitlePath) {
    args.push('--subtitles', subtitlePath)
  }

  // MediaPipe on 4 cores handles a 90s clip well inside this; the timeout is a
  // stuck-process guard, not a performance budget.
  await run(args, { timeoutMs: 15 * 60_000, signal })
}
