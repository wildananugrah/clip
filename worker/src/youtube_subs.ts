import { spawn } from 'node:child_process'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseVttToSegments } from './vtt.ts'
import { segmentsToFullSrt } from './srt_full.ts'
import type { TranscribeResult } from './stages/transcribe.ts'

/**
 * Checks if a video URL is from YouTube.
 */
export function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return (
      host === 'youtube.com' ||
      host === 'www.youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'youtu.be'
    )
  } catch {
    return false
  }
}

/**
 * Attempts to fetch subtitles via yt-dlp without downloading video.
 * Tries original language captions first, then Indonesian, then English, or any auto-caption.
 * Returns TranscribeResult if successful, or null if no subtitles found / error.
 */
export async function tryFetchYouTubeSubtitles(
  videoUrl: string,
  workDir: string,
  logPrefix = '[yt-subs]',
  signal?: AbortSignal,
): Promise<TranscribeResult | null> {
  if (!isYouTubeUrl(videoUrl)) {
    return null
  }
  if (signal?.aborted) throw new Error('Aborted')

  const subOutDir = join(workDir, `subs_${Date.now()}`)
  const outTemplate = join(subOutDir, 'sub.%(ext)s')

  try {
    console.log(`${logPrefix} checking YouTube auto-captions/subtitles for ${videoUrl}...`)
    
    // yt-dlp arguments to grab subtitles without downloading media
    const args = [
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-langs',
      'id-orig,id,en-orig,en,all',
      '--sub-format',
      'vtt',
      '--output',
      outTemplate,
      '--no-playlist',
      videoUrl,
    ]

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const onAbort = signal ? () => proc.kill('SIGKILL') : undefined
    if (signal) {
      if (signal.aborted) proc.kill('SIGKILL')
      else signal.addEventListener('abort', onAbort!, { once: true })
    }
    
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('close', (code) => resolve(code ?? 1))
      proc.on('error', () => resolve(1))
    }).finally(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    })
    if (signal?.aborted) throw new Error('Aborted')

    // Read the subtitle files created in subOutDir
    const files = await readdir(subOutDir).catch(() => [] as string[])
    const vttFiles = files.filter((f) => f.endsWith('.vtt'))

    if (vttFiles.length === 0) {
      console.log(`${logPrefix} no subtitles returned by yt-dlp (exit code ${exitCode})`)
      await rm(subOutDir, { recursive: true, force: true }).catch(() => {})
      return null
    }

    // Prioritize: id-orig > id > en-orig > en > first vtt
    const chosenFile =
      vttFiles.find((f) => f.includes('id-orig')) ||
      vttFiles.find((f) => f.includes('.id.')) ||
      vttFiles.find((f) => f.includes('en-orig')) ||
      vttFiles.find((f) => f.includes('.en.')) ||
      vttFiles[0]

    console.log(`${logPrefix} found subtitle file: ${chosenFile}`)
    const fullPath = join(subOutDir, chosenFile)
    const content = await readFile(fullPath, 'utf8')

    // Clean up temporary subs directory
    await rm(subOutDir, { recursive: true, force: true }).catch(() => {})

    const segments = parseVttToSegments(content)
    if (segments.length === 0) {
      console.log(`${logPrefix} parsed segments are empty, falling back to local Whisper`)
      return null
    }

    // Determine language from filename e.g. "sub.id-orig.vtt"
    let language: string | null = null
    if (chosenFile.includes('id')) language = 'id'
    else if (chosenFile.includes('en')) language = 'en'

    const srt = segmentsToFullSrt(segments)
    console.log(`${logPrefix} successfully extracted ${segments.length} segments from YouTube captions!`)

    return {
      segments,
      language,
      srt,
    }
  } catch (err) {
    console.warn(`${logPrefix} failed to fetch YouTube subtitles:`, err)
    await rm(subOutDir, { recursive: true, force: true }).catch(() => {})
    return null
  }
}
