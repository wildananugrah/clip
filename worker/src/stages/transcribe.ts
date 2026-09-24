/**
 * Transcription via whisper-ctranslate2 (faster-whisper / CTranslate2).
 *
 * Roughly 4x faster than reference whisper on CPU at the same model size.
 * `base` is the default here because 4 cores makes `small` about twice as slow,
 * and the transcript feeds an LLM that tolerates minor noise.
 */
import { join, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { runStreaming, exists } from '../../../shared/proc.ts'
import type { TranscriptSegment } from '../../../shared/schema.ts'
import { extractAudio } from '../ffmpeg.ts'
import { env } from '../env.ts'
import { parseWhisperProgress } from '../parse.ts'

export interface TranscribeResult {
  segments: TranscriptSegment[]
  language: string | null
  srt: string
}

const WHISPER_BIN = 'whisper-ctranslate2'

export async function assertWhisperAvailable(): Promise<void> {
  if (await exists(WHISPER_BIN)) return
  throw new Error(
    `${WHISPER_BIN} not found on PATH. Install it:\n` +
      `  python3 -m venv worker/.venv && worker/.venv/bin/pip install -r worker/python/requirements.txt\n` +
      `then add worker/.venv/bin to PATH, or run scripts/setup-python.sh`,
  )
}

/**
 * Extract audio, transcribe, return segments plus an SRT of the whole source.
 *
 * `onProgress` receives 0..1 across the combined audio-extract and transcribe
 * steps, weighted towards transcription because it dominates by an order of
 * magnitude.
 */
export async function transcribe(
  videoPath: string,
  workDir: string,
  durationSeconds: number,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  await assertWhisperAvailable()

  const audioPath = join(workDir, 'audio.mp3')

  // Audio extraction is ~5% of the work; keep the bar moving during it.
  await extractAudio(videoPath, audioPath, (f) => onProgress(f * 0.05), durationSeconds, signal)

  const cuda = env.WHISPER_DEVICE === 'cuda'
  const args = [
    WHISPER_BIN,
    audioPath,
    '--model',
    env.WHISPER_MODEL,
    '--device',
    env.WHISPER_DEVICE,
    // int8 keeps the model inside a few hundred MB on CPU. float16 on CUDA:
    // large-v3-turbo peaks ~2.7GB of VRAM that way. Set WHISPER_COMPUTE_TYPE=
    // int8_float16 when the GPU is shared and tighter than that.
    '--compute_type',
    env.WHISPER_COMPUTE_TYPE || (cuda ? 'float16' : 'int8'),
    '--threads',
    String(env.WHISPER_THREADS),
    // Streams carry a lot of dead air; skipping it is a large real speedup.
    '--vad_filter',
    'True',
    '--output_format',
    'all',
    '--output_dir',
    workDir,
  ]
  // No --language means autodetect, which is right when sources vary.
  if (env.WHISPER_LANGUAGE) args.push('--language', env.WHISPER_LANGUAGE)

  await runStreaming(
    args,
    (line) => {
      const t = parseWhisperProgress(line)
      if (t !== null && durationSeconds > 0) {
        onProgress(0.05 + 0.95 * Math.min(1, t / durationSeconds))
      }
    },
    { signal },
  )

  const base = basename(audioPath).replace(/\.[^.]+$/, '')
  const jsonPath = join(workDir, `${base}.json`)
  const srtPath = join(workDir, `${base}.srt`)

  const raw = await readFile(jsonPath, 'utf8').catch(() => {
    throw new Error('Transcription finished but produced no JSON output.')
  })
  const parsed = JSON.parse(raw) as { segments?: any[]; language?: string }

  const segments: TranscriptSegment[] = (parsed.segments ?? [])
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text ?? '').trim(),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text)

  if (segments.length === 0) {
    throw new Error(
      'No speech was found in that video. A music-only or silent source cannot be clipped.',
    )
  }

  const srt = await readFile(srtPath, 'utf8').catch(() => '')

  return { segments, language: parsed.language ?? null, srt }
}
