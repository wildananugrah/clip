/**
 * Subprocess helpers. Everything heavy in this project is an external CLI
 * (yt-dlp, ffmpeg, ffprobe, whisper-ctranslate2, autocrop.py), so this is the
 * single place that knows how to run one and read its output.
 */

export class ProcError extends Error {
  constructor(
    readonly cmd: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    // Keep the tail, not the head: ffmpeg and yt-dlp put the actual error last.
    super(`${cmd[0]} exited ${code}: ${stderr.trim().split('\n').slice(-6).join('\n')}`)
    this.name = 'ProcError'
  }
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  /** Kill the process after this many ms. Omit for no limit. */
  timeoutMs?: number
  /** Kill the process if this signal aborts. */
  signal?: AbortSignal
}

/** Run to completion, buffering output. For commands with small, finite output. */
export async function run(cmd: string[], opts: RunOptions = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timer = opts.timeoutMs
    ? setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs)
    : undefined

  const onAbort = opts.signal ? () => proc.kill('SIGKILL') : undefined
  if (opts.signal) {
    if (opts.signal.aborted) {
      proc.kill('SIGKILL')
    } else {
      opts.signal.addEventListener('abort', onAbort!, { once: true })
    }
  }

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (code !== 0) throw new ProcError(cmd, code, stderr)
    return { stdout, stderr }
  } finally {
    if (timer) clearTimeout(timer)
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Run to completion, buffering stdout as bytes.
 *
 * `run` decodes stdout as UTF-8, which silently mangles binary -- lone bytes
 * become U+FFFD and the length changes. Raw PCM off an ffmpeg pipe needs this
 * instead. stderr is still text, since that is where the error message is.
 */
export async function runBinary(cmd: string[], opts: RunOptions = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timer = opts.timeoutMs
    ? setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs)
    : undefined

  const onAbort = opts.signal ? () => proc.kill('SIGKILL') : undefined
  if (opts.signal) {
    if (opts.signal.aborted) {
      proc.kill('SIGKILL')
    } else {
      opts.signal.addEventListener('abort', onAbort!, { once: true })
    }
  }

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (code !== 0) throw new ProcError(cmd, code, stderr)
    return { stdout: Buffer.from(stdout), stderr }
  } finally {
    if (timer) clearTimeout(timer)
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Run while streaming stderr line by line -- ffmpeg and yt-dlp both report
 * progress there, so buffering would hide it until the process ended.
 *
 * `onLine` must not throw; a listener error would leave the process orphaned.
 */
export async function runStreaming(
  cmd: string[],
  onLine: (line: string) => void,
  opts: RunOptions = {},
) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const onAbort = opts.signal ? () => proc.kill('SIGKILL') : undefined
  if (opts.signal) {
    if (opts.signal.aborted) {
      proc.kill('SIGKILL')
    } else {
      opts.signal.addEventListener('abort', onAbort!, { once: true })
    }
  }

  const tail: string[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      // yt-dlp redraws its progress line with \r; treat it as a line break.
      buf += decoder.decode(chunk, { stream: true })
      const parts = buf.split(/[\r\n]/)
      buf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
        try {
          onLine(line)
        } catch {
          // A progress callback must never kill the job it is reporting on.
        }
      }
    }
    if (buf.trim()) {
      tail.push(buf)
      try {
        onLine(buf)
      } catch {
        /* as above */
      }
    }
  }

  try {
    const [, , code] = await Promise.all([pump(proc.stderr), pump(proc.stdout), proc.exited])
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (code !== 0) throw new ProcError(cmd, code, tail.join('\n'))
  } finally {
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
  }
}

/** True when the binary resolves on PATH. */
export async function exists(bin: string): Promise<boolean> {
  try {
    await run(['sh', '-c', `command -v ${bin}`])
    return true
  } catch {
    return false
  }
}
