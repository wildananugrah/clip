/**
 * API client. The prototype made no network calls at all, so this is the whole
 * boundary between the app and the backend.
 */
import type {
  Clip,
  Project,
  QuotaDTO,
  Ratio,
  Source,
  JobStatus,
  TranscriptLine,
  RecommendationRound,
} from '../types'

/**
 * Every path here is relative, and there is deliberately no configurable base
 * URL. The SPA and API share an origin in production (nginx) and in development
 * (Vite proxies /api), and the session cookie only travels same-origin anyway --
 * so an absolute base could never be right, only wrong. A VITE_API_URL in a
 * stray .env.local once baked http://localhost:3014 into a production build and
 * sent sign-in to the visitor's own machine.
 */

/** Thrown for any non-2xx response, carrying the server's own message. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
      // The session cookie. 'same-origin' is fetch's default, but it is stated
      // because it is the whole authentication story since Tier C -- there is no
      // token in this bundle any more.
      credentials: 'same-origin',
    })
  } catch {
    // A network failure has no response body, so it needs its own message --
    // "Failed to fetch" tells a user nothing actionable.
    throw new ApiError(0, 'Could not reach the server. Is the API running?')
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface JobSnapshot {
  id: string
  status: JobStatus
  stage: string | null
  progress: number
  error: string | null
  clipCount: number
  lengthIdx: number
  formats: Record<Ratio, boolean>
  subs: boolean
  source: Source
  clips: Omit<Clip, 'selected'>[]
  createdAt: string
  completedAt: string | null
}

export interface ProgressEvent {
  jobId: string
  status: JobStatus
  stage: string | null
  progress: number
  error: string | null
}

/** The signed-in user, as /api/auth/me reports them. */
export interface Me {
  id: string
  email: string
  name: string | null
  pictureUrl: string | null
  /**
   * Which features this server has switched on.
   *
   * Server-owned, because the frontend is a static build and cannot read the
   * server's environment. Read each as `state.user?.features?.editor ?? false`
   * -- defaulting to false while /me is still in flight, because a control that
   * flashes into view for a moment and then vanishes is worse than one that
   * never appears. That is also why `features` itself is optional-chained: an
   * older API answering this call has no such object.
   */
  features: {
    editor: boolean
    recommendations: boolean
  }
}

export const auth = {
  /**
   * Who is signed in, or null. Called once at boot, so a 401 is the expected
   * answer for a visitor rather than an error worth surfacing.
   */
  async me(): Promise<Me | null> {
    try {
      return await call<Me>('/auth/me')
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  },

  /** Leaves the SPA entirely: Google's consent screen is not an XHR. */
  signInWithGoogle(): void {
    window.location.href = '/api/auth/google'
  },

  logout: () => call<void>('/auth/logout', { method: 'POST' }),
}

/** First retry after a second, doubling, capped so a long outage still recovers. */
export function retryDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** attempt)
}

/** Injection seam: `bun test` has no EventSource, and real timers make tests slow. */
export interface SubscribeDeps {
  open: (url: string) => EventSource
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * Subscribe to job progress, reconnecting until the caller unsubscribes.
 *
 * No credentials in the URL: EventSource cannot set an Authorization header,
 * which is why the shared token used to ride in the query string (and into
 * nginx's access log), but it sends same-origin cookies natively.
 *
 * The reconnect is the point. An API restart, a sleeping laptop or a throttled
 * background tab all drop the stream; closing it for good meant a job that
 * finished afterwards stayed invisible until the user reloaded. `onError` fires
 * on every drop so the caller can re-fetch the job and never sit on a stale bar.
 */
export function subscribe(
  jobId: string,
  onEvent: (e: ProgressEvent) => void,
  onError?: () => void,
  deps: SubscribeDeps = {
    open: (url) => new EventSource(url),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  },
): () => void {
  let stopped = false
  let attempt = 0
  let es: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = () => {
    if (stopped) return
    const source = deps.open(`/api/jobs/${jobId}/events`)
    es = source

    source.onmessage = (msg: MessageEvent) => {
      if (!msg.data) return // keep-alive ping
      let parsed: ProgressEvent
      try {
        parsed = JSON.parse(msg.data) as ProgressEvent
      } catch {
        return // A malformed frame must not tear down a working stream.
      }
      // A frame proves the connection works, so the next outage starts over at
      // one second rather than inheriting a long backoff from an old blip.
      attempt = 0
      onEvent(parsed)
    }

    source.onerror = () => {
      source.close()
      if (stopped) return
      onError?.()
      timer = deps.setTimeout(connect, retryDelay(attempt++))
    }
  }

  connect()

  return () => {
    stopped = true
    if (timer) deps.clearTimeout(timer)
    es?.close()
  }
}

export const api = {
  analyze: (url: string) => call<Source>('/sources/analyze', {
    method: 'POST',
    body: JSON.stringify({ url }),
  }),

  createJob: (body: {
    videoId: string
    count: number
    lengthIdx: number
    formats: Record<Ratio, boolean>
    subs: boolean
    /** Free-text brief steering which moments get picked. '' means none. */
    prompt: string
  }) => call<{ jobId: string }>('/jobs', { method: 'POST', body: JSON.stringify(body) }),

  getJob: (id: string) => call<JobSnapshot>(`/jobs/${id}`),

  /**
   * The job still running, or null. Asked once at boot so the progress indicator
   * works on every screen without the app having to remember an id -- jobId
   * lives in localStorage, so a job started on another device is invisible to it
   * and clearing site data loses it.
   */
  activeJob: () => call<JobSnapshot | null>('/jobs/active'),

  /**
   * The daily allowance. Refetched after anything that spends or frees a slot,
   * because the count lives on the server -- see quota() in lib/derive.ts.
   */
  quota: () => call<QuotaDTO>('/jobs/quota'),

  cancelJob: (id: string) => call<{ ok: boolean; status: string }>(`/jobs/${id}/cancel`, { method: 'POST' }),

  regenerate: (id: string) =>
    call<{ jobId: string }>(`/jobs/${id}/regenerate`, { method: 'POST' }),

  /**
   * Suggested moments for a finished project, oldest round first.
   *
   * 404 when the feature is switched off, which is the same answer as a job
   * that does not exist -- deliberately, see recommendationsGate.ts. The panel
   * is hidden by the flag on /me long before this is called, so a 404 here
   * means the flag changed under a tab that was already open.
   */
  recommendations: (jobId: string) =>
    call<{ rounds: RecommendationRound[] }>(`/jobs/${jobId}/recommendations`),

  /**
   * Ask for a different set. Synchronous and slow by UI standards -- the server
   * is waiting on a model, five to fifteen seconds -- so callers must show that
   * something is happening rather than assume this returns promptly.
   */
  recommend: (jobId: string, message: string) =>
    call<RecommendationRound>(`/jobs/${jobId}/recommendations`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  /**
   * Turn chosen recommendations into clips. Indices into the round, not raw
   * ranges: the server re-reads its own stored candidate either way.
   *
   * The clips come back `pending`; they render on the same queue as Redo.
   */
  createClips: (jobId: string, roundId: string, indices: number[]) =>
    call<Clip[]>(`/jobs/${jobId}/clips`, {
      method: 'POST',
      body: JSON.stringify({ roundId, indices }),
    }),

  projects: () => call<Project[]>('/projects'),

  deleteProject: (id: string) =>
    call<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  redoClip: (clipId: string) => call<{ ok: boolean }>(`/clips/${clipId}/redo`, { method: 'POST' }),

  /**
   * Ask for the editor's preview assets for a project that has none.
   *
   * Idempotent, and cheap to call on every editor open: the server answers 204
   * when every clip already has them, and the queue collapses duplicates.
   */
  prepareAssets: (jobId: string) =>
    call<{ ok: boolean; pending: number } | undefined>(`/jobs/${jobId}/assets`, {
      method: 'POST',
    }),

  /**
   * Ensure the FULL-LENGTH source assets exist, so the timeline window can be
   * placed anywhere in the video.
   *
   * Also stamps the server's least-recently-used clock, which is what keeps the
   * source you are working on from being the one retention evicts.
   */
  prepareSource: (jobId: string) =>
    call<{ ready: boolean; pending?: boolean }>(`/jobs/${jobId}/source`, { method: 'POST' }),

  /** Transcript lines covering the clip's editor window, not just the cut. */
  clipTranscript: (clipId: string) =>
    call<{ segments: TranscriptLine[] }>(`/clips/${clipId}/transcript`),

  /**
   * Save an edited range as a new clip, leaving the original alone.
   *
   * Answers the new clip, already queued for rendering -- so the caller polls
   * the id it gets back, never the one it edited from.
   */
  copyClip: (clipId: string, s: number, e: number) =>
    call<Omit<Clip, 'selected'>>(`/clips/${clipId}/copy`, {
      method: 'POST',
      body: JSON.stringify({ s, e }),
    }),

  subscribe,

  /**
   * Download one or more clips.
   *
   * A single clip goes straight to its signed media URL; several are zipped by
   * the server. The blob dance is needed because the zip is a POST, which a
   * plain link cannot express.
   */
  async download(clipIds: string[], ratio: Ratio, urlForSingle?: string | null): Promise<void> {
    if (clipIds.length === 1 && urlForSingle) {
      triggerDownload(`${urlForSingle}&download=1`)
      return
    }

    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ clipIds, ratio }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new ApiError(res.status, body?.error ?? 'Download failed')
    }

    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, `clips-${ratio.replace(':', 'x')}.zip`)
    // Revoke on the next tick: revoking immediately races the click handler.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  },
}

function triggerDownload(url: string, filename?: string) {
  const a = document.createElement('a')
  a.href = url
  if (filename) a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
