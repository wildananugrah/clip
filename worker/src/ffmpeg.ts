/**
 * ffmpeg / ffprobe wrappers.
 *
 * Conventions inherited from clipper/clip.sh, and they are load-bearing:
 *   - `-ss` goes BEFORE `-i` (fast seek). After `-i` it decodes from zero.
 *   - duration via `-t`, never `-to`: with a pre-input `-ss`, `-to` is
 *     interpreted against the original timeline, not the seek point.
 *   - audio is mapped `0:a?` so a silent source does not fail the encode.
 */
import { run, runStreaming } from '../../shared/proc.ts'

/**
 * VIDEO_ENCODER=nvenc moves H.264 encode onto an NVIDIA GPU.
 *
 * Read from process.env rather than env.ts, which exits the process without a
 * database -- and the tests import this file. env.ts still validates the value
 * at boot. autocrop.py reads the same variable, so one switch covers every
 * encode the worker does.
 *
 * ponytail: measured on an RTX 5090 + 24 cores (2026-09-23, 1080p30 source),
 * this is SLOWER than libx264 veryfast: 60s cut 4.6s vs 2.8s, 300s proxy 12.5s
 * vs 5.3s. Filters (crop, scale, libass) run on the CPU, so every frame crosses
 * PCIe twice, and `-hwaccel cuda` decode was 5.6x slower than software -- which
 * is why there is no hwaccel here. It only wins when the CPU is the scarce
 * thing. A real speedup needs scale_cuda/crop on the GPU and subtitles burned
 * via overlay_cuda, i.e. an ffmpeg built with those filters.
 */
const nvenc = () => process.env.VIDEO_ENCODER === 'nvenc'

/**
 * H.264 encode arguments. `quality` is the x264 CRF; NVENC's constant-quality
 * mode takes the same number. They are not the same scale, but they are close
 * enough that a clip looks the same after switching.
 */
export function h264Args(quality: number): string[] {
  if (nvenc()) {
    return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0', '-pix_fmt', 'yuv420p']
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality), '-pix_fmt', 'yuv420p']
}

/**
 * Fail at boot, not after a 40-minute transcription, when nvenc is asked for
 * and the GPU, driver or container device mapping is not there.
 */
export async function assertEncoderAvailable(): Promise<void> {
  if (!nvenc()) return
  await run([
    'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.1',
    ...h264Args(23), '-f', 'null', '-',
  ]).catch((e: Error) => {
    throw new Error(`VIDEO_ENCODER=nvenc but NVENC does not work here: ${e.message}`)
  })
}

export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run([
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  const n = Number(stdout.trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Could not read duration of ${path}`)
  return n
}

export async function probeDimensions(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run([
    'ffprobe',
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    path,
  ])
  const [w, h] = stdout.trim().split(',').map(Number)
  if (!w || !h) throw new Error(`Could not read dimensions of ${path}`)
  return { width: w, height: h }
}

/**
 * 16 kHz mono mp3 for whisper.
 *
 * Whisper resamples to 16 kHz internally, so extracting at that rate costs no
 * accuracy and makes the file ~150x smaller than the video.
 */
export async function extractAudio(
  input: string,
  output: string,
  onProgress?: (fraction: number) => void,
  totalDuration?: number,
  signal?: AbortSignal,
): Promise<string> {
  await runStreaming(
    [
      'ffmpeg',
      '-nostdin',
      '-loglevel',
      'error',
      '-stats',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '4',
      output,
      '-y',
    ],
    (line) => {
      if (!onProgress || !totalDuration) return
      const t = parseFfmpegTime(line)
      if (t !== null) onProgress(Math.min(1, t / totalDuration))
    },
    { signal },
  )
  return output
}

/** Cut [start, start+duration) with a stream copy. Fast; keyframe-aligned. */
export async function cut(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<string> {
  await run([
    'ffmpeg',
    '-nostdin',
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(start),
    '-i',
    input,
    '-t',
    String(duration),
    '-c',
    'copy',
    '-avoid_negative_ts',
    'make_zero',
    output,
  ])
  return output
}

/**
 * Cut with re-encoding, for frame-accurate boundaries.
 *
 * A stream copy can only cut on keyframes, so boundaries drift a second or two.
 * That is fine for a 60-second clip but visibly wrong when the hook is the first
 * word, so the pipeline re-encodes.
 */
export async function cutAccurate(
  input: string,
  output: string,
  start: number,
  duration: number,
  signal?: AbortSignal,
): Promise<string> {
  await run(
    [
      'ffmpeg',
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(start),
      '-i',
      input,
      '-t',
      String(duration),
      ...h264Args(20),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      output,
    ],
    { signal },
  )
  return output
}

/** Single JPEG poster frame, taken a beat into the clip to avoid a black first frame. */
export async function thumbnail(
  input: string,
  output: string,
  atSeconds = 1,
  signal?: AbortSignal,
): Promise<string> {
  await run(
    [
      'ffmpeg',
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(atSeconds),
      '-i',
      input,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      output,
    ],
    { signal },
  )
  return output
}

/**
 * Static centre crop + scale, with optional burned subtitles.
 * The fallback path when speaker-tracking autocrop is unavailable or fails.
 */
export async function reframeStatic(
  input: string,
  output: string,
  outW: number,
  outH: number,
  subtitlePath?: string,
  signal?: AbortSignal,
): Promise<string> {
  const { width, height } = await probeDimensions(input)
  const { w: cropW, h: cropH, x, y } = centreCrop(width, height, outW, outH)

  const chain = [`crop=${cropW}:${cropH}:${x}:${y}`, `scale=${outW}:${outH}`]
  // Subtitles go AFTER scale: the ASS declares PlayRes equal to the output
  // size, so burning before the scale would resize the text along with it.
  if (subtitlePath) chain.push(subtitleFilter(subtitlePath))
  chain.push('setsar=1')

  await run(
    [
      'ffmpeg',
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-vf',
      chain.join(','),
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      ...h264Args(20),
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      output,
    ],
    { signal },
  )
  return output
}

/**
 * Largest centred box of the target aspect that fits the source.
 *
 * Full height when the source is wider than the target, full width otherwise --
 * a portrait source going to 16:9 has to lose rows, not get stretched.
 */
export function centreCrop(width: number, height: number, outW: number, outH: number) {
  const even = (n: number) => n + (n % 2)
  let w = even(Math.round((height * outW) / outH))
  let h = height
  if (w > width) {
    w = width
    h = Math.min(even(Math.round((width * outH) / outW)), height)
  }
  return {
    w,
    h,
    x: Math.max(0, Math.round((width - w) / 2)),
    y: Math.max(0, Math.round((height - h) / 2)),
  }
}

/**
 * Build a `subtitles=` filter argument.
 *
 * ffmpeg's filtergraph parser treats `:`, `,`, `'` and `\` as structure, so a
 * path containing any of them silently produces a broken graph rather than an
 * error. Escaping is mandatory, not defensive.
 */
export function subtitleFilter(path: string): string {
  const escaped = path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
  return `subtitles='${escaped}'`
}

/** "frame= 123 fps=... time=00:01:23.45 ..." -> seconds, or null. */
export function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d{2}):(\d{2})\.(\d+)/)
  if (!m) return null
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + Number(`0.${m[4]}`)
}
