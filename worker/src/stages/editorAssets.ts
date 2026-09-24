/**
 * Editor assets: the three things the editor timeline needs and the pipeline
 * otherwise throws away.
 *
 * The source video does not survive its job -- the work dir is removed on every
 * exit path and the source is never uploaded -- so without these the editor has
 * nothing to play, and its filmstrip and waveform stay the hatched divs and the
 * 28-element fixture array they were in the prototype.
 *
 * Only the timeline window is kept, not the whole video. The editor can never
 * scrub outside it, and a 150-second 240p proxy is ~6MB against a 5GB quota
 * where the source would be gigabytes.
 *
 * Three separate ffmpeg calls rather than one filter_complex: they are legible
 * one at a time, and when a codec is missing the failure names which step.
 */
import { join } from 'node:path'
import { run, runBinary } from '../../../shared/proc.ts'
import { EDITOR_LEAD_IN as LEAD_IN, EDITOR_SPAN as SPAN } from '../../../shared/types.ts'
import { probeDuration, h264Args } from '../ffmpeg.ts'

/** Frames tiled into the filmstrip. Mirrors FILMSTRIP_FRAMES on the editor screen. */
export const STRIP_FRAMES = 16
/** Waveform resolution. One bar per second of a full-length window. */
export const PEAK_BUCKETS = 150

/** PCM sample rate for the peaks pass. Low, because only envelope shape matters. */
const PEAK_RATE = 8000

/**
 * Clips of a job that still have no editor proxy.
 *
 * The selection is the part worth protecting: a backfill that re-did clips
 * which already had assets would pay for a whole project's encodes every time
 * somebody opened the editor.
 */
export function needingAssets<T extends { proxyKey: string | null }>(rows: T[]): T[] {
  return rows.filter((c) => !c.proxyKey)
}

export interface EditorWindow {
  start: number
  span: number
}

/**
 * The slice of source the editor will show.
 *
 * Clamped at both ends: a clip at t=10 cannot have a full lead-in, and one near
 * the end cannot have a full span. The result is stored on the clip rather than
 * recomputed downstream precisely because of those two cases -- a frontend
 * assuming `start - LEAD_IN` would map its timeline to the wrong frames.
 */
export function windowFor(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number,
): EditorWindow {
  const duration = Math.max(0, durationSeconds)
  /**
   * Never shorter than the clip PLUS its lead-in, or the trim handles open
   * outside the window they are supposed to bound. The lead-in has to be in the
   * sum: the window starts before the clip does, so covering only `end - start`
   * leaves it ending short by exactly that much.
   */
  const needed = Math.max(SPAN, endSeconds - startSeconds + LEAD_IN)
  const span = Math.min(needed, duration)
  const start = Math.max(0, Math.min(startSeconds - LEAD_IN, duration - span))
  return { start, span }
}

/**
 * Bucket signed 16-bit mono PCM into RMS levels, 0-100.
 *
 * RMS rather than peak amplitude: a single loud sample makes a peak meter spike
 * to full height and every bar then looks the same, which is what a waveform is
 * for distinguishing. Normalised against the loudest bucket so quiet recordings
 * still fill the strip.
 */
export function peaksFromPcm(pcm: Buffer, buckets = PEAK_BUCKETS): number[] {
  const samples = Math.floor(pcm.length / 2)
  if (samples === 0 || buckets <= 0) return []

  const out: number[] = []
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * samples) / buckets)
    const to = Math.max(from + 1, Math.floor(((b + 1) * samples) / buckets))

    let sum = 0
    let n = 0
    for (let i = from; i < to && i < samples; i++) {
      const s = pcm.readInt16LE(i * 2) / 32768
      sum += s * s
      n++
    }
    out.push(n === 0 ? 0 : Math.sqrt(sum / n))
  }

  const loudest = Math.max(...out)
  if (loudest === 0) return out.map(() => 0)
  return out.map((v) => Math.round((v / loudest) * 100))
}

export interface EditorAssets {
  proxyPath: string
  stripPath: string
  peaks: number[]
  window: EditorWindow
}

/**
 * Encode the proxy, tile a filmstrip from it, and measure its audio.
 *
 * `durationSeconds` is probed from the source when not supplied; the caller
 * usually knows it already from the videos row.
 */
export async function buildEditorAssets(opts: {
  sourcePath: string
  workDir: string
  stem: string
  startSeconds: number
  endSeconds: number
  durationSeconds?: number
  signal?: AbortSignal
}): Promise<EditorAssets> {
  const duration = opts.durationSeconds ?? (await probeDuration(opts.sourcePath))
  const win = windowFor(opts.startSeconds, opts.endSeconds, duration)

  const proxyPath = join(opts.workDir, `${opts.stem}-proxy.mp4`)
  const stripPath = join(opts.workDir, `${opts.stem}-strip.jpg`)

  await run(
    [
      'ffmpeg',
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      // Fast seek, before -i, and duration via -t: the same two rules cutAccurate
      // follows, and for the same reasons.
      '-ss',
      String(win.start),
      '-i',
      opts.sourcePath,
      '-t',
      String(win.span),
      '-vf',
      // -2 keeps width even, which yuv420p requires.
      'scale=-2:240',
      ...h264Args(32),
      // Keyframe every second, so scrubbing lands near where it was dropped
      // rather than at the previous keyframe several seconds back.
      '-g',
      '25',
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      '-ac',
      '1',
      // Load-bearing: without the moov atom at the front the browser cannot seek
      // over range requests, and the scrubber silently does nothing.
      '-movflags',
      '+faststart',
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      proxyPath,
    ],
    { signal: opts.signal },
  )

  // From the proxy, not the source: it is already the right window and 240p, so
  // this costs almost nothing next to decoding gigabytes again.
  await run(
    [
      'ffmpeg',
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      proxyPath,
      '-vf',
      `fps=${STRIP_FRAMES}/${win.span},scale=-2:72,tile=${STRIP_FRAMES}x1`,
      '-frames:v',
      '1',
      '-q:v',
      '5',
      stripPath,
    ],
    { signal: opts.signal },
  )

  const peaks = await peaksOf(proxyPath, opts.signal)

  return { proxyPath, stripPath, peaks, window: win }
}

/**
 * Decode a file's audio to raw PCM on stdout and bucket it.
 *
 * A silent source has no audio stream at all, and `-map 0:a?` in the proxy
 * encode means the proxy may have none either. ffmpeg fails rather than
 * producing zero bytes, so that case answers with a flat waveform instead of
 * taking the whole stage down.
 */
async function peaksOf(path: string, signal?: AbortSignal): Promise<number[]> {
  try {
    const { stdout } = await runBinary(
      [
        'ffmpeg',
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(PEAK_RATE),
        '-f',
        's16le',
        '-',
      ],
      { signal },
    )
    return peaksFromPcm(stdout)
  } catch (e) {
    if (signal?.aborted || (e as Error)?.name === 'AbortError') throw e
    return Array.from({ length: PEAK_BUCKETS }, () => 0)
  }
}
