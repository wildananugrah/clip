import { test, expect, describe } from 'bun:test'
import { mkdtemp, writeFile, readFile, chmod, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withYtdlpArgs, estimateBytes } from './ytdlp.ts'

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

describe('withYtdlpArgs', () => {
  test('enables bun as the JS runtime by default, with no cookies', async () => {
    const args = await withYtdlpArgs(async (a) => a, {})
    expect(args).toEqual(['--js-runtimes', 'bun'])
  })

  test('a blank runtime omits the flag', async () => {
    const args = await withYtdlpArgs(async (a) => a, { jsRuntimes: '' })
    expect(args).toEqual([])
  })

  test('passes a private, writable copy of a read-only cookies file and removes it after', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ytdlp-test-'))
    try {
      const src = join(dir, 'cookies.txt')
      await writeFile(src, '# Netscape HTTP Cookie File\n')
      await chmod(src, 0o444) // yt-dlp crashes on exit when it cannot write the jar back

      let copy = ''
      await withYtdlpArgs(
        async (a) => {
          copy = a[a.indexOf('--cookies') + 1]
          expect(copy).not.toBe(src)
          expect(await readFile(copy, 'utf8')).toBe('# Netscape HTTP Cookie File\n')
          await writeFile(copy, 'rotated by yt-dlp\n')
        },
        { cookiesFile: src },
      )

      expect(await exists(copy)).toBe(false)
      expect(await readFile(src, 'utf8')).toBe('# Netscape HTTP Cookie File\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('removes the cookies copy when the call fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ytdlp-test-'))
    try {
      const src = join(dir, 'cookies.txt')
      await writeFile(src, 'x')

      let copy = ''
      const p = withYtdlpArgs(
        async (a) => {
          copy = a[a.indexOf('--cookies') + 1]
          throw new Error('yt-dlp exited 1')
        },
        { cookiesFile: src },
      )
      await expect(p).rejects.toThrow('yt-dlp exited 1')
      expect(await exists(copy)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('names the setting when the cookies file is missing', async () => {
    const p = withYtdlpArgs(async (a) => a, { cookiesFile: '/nonexistent/cookies.txt' })
    await expect(p).rejects.toThrow(/YTDLP_COOKIES/)
  })
})

describe('estimateBytes', () => {
  test('fills an HLS part with no size from its bitrate', () => {
    // Z7bUQpa89fs as yt-dlp resolved it: the top-level filesize_approx was
    // 43759660 -- the audio alone -- for a ~1.4GB download.
    const j = {
      filesize_approx: 43759660,
      requested_formats: [
        { format_id: '270', protocol: 'm3u8_native', tbr: 4133.399 },
        { format_id: '140', protocol: 'https', filesize: 43759660, tbr: 129.473 },
      ],
    }
    const bytes = estimateBytes(j, 2704)!
    expect(bytes).toBeGreaterThan(1.3e9)
    expect(bytes).toBeLessThan(1.6e9)
  })

  test('sums known sizes of a DASH pair', () => {
    const j = { requested_formats: [{ filesize: 700 }, { filesize_approx: 40 }] }
    expect(estimateBytes(j, 100)).toBe(740)
  })

  test('reads a single format from the top level', () => {
    expect(estimateBytes({ filesize: 1234 }, 100)).toBe(1234)
  })

  test('is null when a part has neither size nor bitrate', () => {
    const j = { requested_formats: [{ filesize: 700 }, {}] }
    expect(estimateBytes(j, 100)).toBeNull()
  })
})
