/**
 * yt-dlp wrapper: metadata probe and download.
 *
 * The format picker is inherited from clipper/run.sh and is load-bearing --
 * it forces H.264/AAC so that later cuts stream-copy without re-encoding.
 * YouTube's default "best" is VP9/Opus, which lands in .webm and forces a
 * per-clip re-encode.
 */
import { statfs } from 'node:fs/promises'
import { run, runStreaming, ProcError } from './proc.ts'

export const DEFAULT_FORMAT =
  process.env.YTDLP_FORMAT ?? 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/bv*+ba/b'

export interface ProbeResult {
  id: string
  title: string
  durationSeconds: number
  platform: string
  uploader: string | null
  uploadDate: string | null
  thumbnail: string | null
  maxHeight: number | null
  isLive: boolean
  /** Best-effort byte size of the selected format; null when yt-dlp omits it. */
  estimatedBytes: number | null
}

/**
 * YouTube rotates its format-URL signing every few weeks. A stale yt-dlp still
 * resolves the title and formats, then dies partway through a multi-GB download
 * with "HTTP Error 403: Forbidden". Fail before spending the bandwidth.
 */
export async function assertYtdlpFresh(maxAgeDays: number): Promise<void> {
  let version: string
  try {
    const { stdout } = await run(['yt-dlp', '--version'])
    version = stdout.trim().split('\n').pop()!.trim()
  } catch {
    throw new Error('yt-dlp not found on PATH. Install it: pip install -U yt-dlp')
  }

  const m = version.match(/^(\d{4})\.(\d{2})\.(\d{2})/)
  if (!m) return // Unrecognised versioning (a git build); assume the user knows.

  const released = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const ageDays = Math.floor((Date.now() - released) / 86_400_000)
  if (ageDays > maxAgeDays) {
    throw new Error(
      `yt-dlp ${version} is ${ageDays} days old (limit ${maxAgeDays}). ` +
        `Stale builds fail partway through a download with HTTP 403. ` +
        `Upgrade with: pip install -U yt-dlp  (or raise YTDLP_MAX_AGE_DAYS)`,
    )
  }
}

/** Metadata only -- no download. Fast enough to run inline on an API request. */
export async function probe(url: string): Promise<ProbeResult> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      ['yt-dlp', '--dump-single-json', '--no-playlist', '--no-warnings', '-f', DEFAULT_FORMAT, url],
      { timeoutMs: 60_000 },
    ))
  } catch (e) {
    if (e instanceof ProcError) {
      throw new Error(`Could not read that URL. ${firstUsefulLine(e.stderr)}`)
    }
    throw e
  }

  const j = JSON.parse(stdout) as Record<string, any>

  // Live streams have no duration and cannot be clipped as a fixed range.
  if (j.is_live) throw new Error('That URL is a live stream. Wait for the VOD, then try again.')

  const duration = Math.round(Number(j.duration ?? 0))
  if (!duration || duration < 30) {
    throw new Error('That video is too short to clip (needs at least 30 seconds).')
  }

  const formats: any[] = Array.isArray(j.formats) ? j.formats : []
  const maxHeight = formats.reduce<number | null>(
    (acc, f) => (typeof f?.height === 'number' && (acc === null || f.height > acc) ? f.height : acc),
    null,
  )

  return {
    id: String(j.id ?? ''),
    title: String(j.title ?? 'Untitled'),
    durationSeconds: duration,
    platform: prettyPlatform(j.extractor_key ?? j.extractor ?? 'Unknown'),
    uploader: j.uploader ?? j.channel ?? null,
    uploadDate: j.upload_date ?? null,
    thumbnail: j.thumbnail ?? null,
    maxHeight,
    isLive: Boolean(j.was_live),
    estimatedBytes: Number(j.filesize ?? j.filesize_approx ?? 0) || null,
  }
}

/**
 * Download into `outDir`. Reports 0..1 progress.
 *
 * Returns the absolute path of the downloaded file. yt-dlp's `--print after_move`
 * is what makes this reliable -- globbing the directory races with .part files
 * and picks the wrong one when a previous run left debris.
 */
export async function download(
  url: string,
  outDir: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const template = `${outDir}/source.%(ext)s`
  let finalPath = ''

  await runStreaming(
    [
      'yt-dlp',
      '--no-playlist',
      '--no-warnings',
      '--newline', // one progress line per update instead of \r redraws
      '--progress', // --print implies --quiet, which would suppress progress entirely
      '--no-part', // avoid .part debris if the worker is killed
      '-f',
      DEFAULT_FORMAT,
      '--print',
      'after_move:%(filepath)s',
      '-o',
      template,
      url,
    ],
    (line) => {
      const pct = line.match(/\[download\]\s+([\d.]+)%/)
      if (pct) {
        onProgress(Math.min(1, Number(pct[1]) / 100))
        return
      }
      // The --print output arrives on stdout as a bare path.
      if (line.startsWith('/') && !line.includes(' ')) finalPath = line.trim()
    },
    { signal },
  )

  if (!finalPath) throw new Error('Download finished but produced no file path.')
  return finalPath
}

/** Free bytes on the filesystem holding `path`. */
export async function freeDiskBytes(path: string): Promise<number> {
  const s = await statfs(path)
  return Number(s.bavail) * Number(s.bsize)
}

/**
 * Refuse a job that would fill the disk.
 *
 * Budget is 3x the source: the download, the cut clips, and the rendered
 * outputs all coexist until finalize. On a 14GB-free box with GB-scale VODs
 * this is the constraint that actually bites, and filling the disk takes
 * Postgres down with it.
 */
export async function assertDiskSpace(
  workDir: string,
  estimatedBytes: number | null,
  minFreeGb: number,
): Promise<void> {
  const free = await freeDiskBytes(workDir)
  const minFree = minFreeGb * 1024 ** 3

  if (free < minFree) {
    throw new Error(
      `Not enough disk space: ${gb(free)} free, need at least ${minFreeGb} GB. Free some space and retry.`,
    )
  }

  if (estimatedBytes) {
    const needed = estimatedBytes * 3
    if (free < needed) {
      throw new Error(
        `Not enough disk space for this video: ${gb(free)} free, ` +
          `need ~${gb(needed)} (source ${gb(estimatedBytes)} plus clips and renders).`,
      )
    }
  }
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`

function prettyPlatform(key: string): string {
  const map: Record<string, string> = {
    Youtube: 'YouTube',
    'Youtube:tab': 'YouTube',
    Twitch: 'Twitch',
    'Twitch:vod': 'Twitch VOD',
    TwitchVod: 'Twitch VOD',
    Kick: 'Kick',
    Vimeo: 'Vimeo',
    TikTok: 'TikTok',
    Twitter: 'X',
  }
  return map[key] ?? key
}

function firstUsefulLine(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((l) => l.replace(/^ERROR:\s*/, '').trim())
    .find((l) => l && !l.startsWith('WARNING'))
  return line ?? 'The URL could not be resolved.'
}
