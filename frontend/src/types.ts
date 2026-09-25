export type Screen =
  /**
   * Before /api/auth/me has answered. Renders nothing: without it every reload
   * flashes the login screen for a moment before landing on your projects.
   */
  | 'booting'
  /** The public front page, at /. Visitors only: signed-in users get the app there. */
  | 'landing'
  /** Sign-in, at /login. */
  | 'login'
  | 'new'
  | 'setup'
  | 'processing'
  | 'results'
  | 'projects'
  | 'plan'
  | 'settings'
  | 'editor'

/** The app screens that sit inside the signed-in shell with the sidebar. */
export const APP_SCREENS = [
  'new',
  'setup',
  'processing',
  'results',
  'projects',
  'plan',
  'settings',
] as const satisfies readonly Screen[]

/**
 * The monthly job allowance, as GET /api/jobs/quota reports it. Mirrors QuotaDTO
 * in shared/types.ts; the frontend declares its own view of the wire types
 * rather than importing across the workspace, as it does for JobSnapshot.
 *
 * Only the server can compute this: it is a count of the user's jobs since
 * the 1st of the month (UTC), so it survives reloads and covers other devices.
 */
export interface QuotaDTO {
  used: number
  limit: number
  remaining: number
  /** Rendered bytes held, and the cap. Deleting a project lowers the first. */
  storageBytes: number
  storageLimitBytes: number
  /** ISO time the allowance resets (1st of next month, UTC). Null from an older server. */
  resetsAt: string | null
}

export type Ratio = '9:16' | '1:1' | '4:5'

/** Which sample link the "try one of these" buttons load. */
export type SourceKey = 'stream' | 'podcast'

export type JobStatus =
  | 'pending'
  | 'downloading'
  | 'transcribing'
  | 'analyzing'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * A resolved source video.
 *
 * `length` and `eta` stay display strings so the source card renders unchanged,
 * but `durationSeconds` is now carried alongside them -- the prototype had only
 * the formatted string, which nothing downstream could compute with.
 */
export interface Source {
  /** Server id, needed to start a job against this source. */
  videoId: string
  platform: string
  title: string
  length: string
  durationSeconds: number
  meta: string
  eta: string
  thumbnailUrl: string | null
  /**
   * Full-length editor assets, present only once manual mode has built them.
   *
   * Null covers both "never built" and "evicted by retention" -- the editor
   * treats them identically, because the answer to both is to ask for a build.
   */
  proxyUrl?: string | null
  stripUrl?: string | null
  /** RMS 0-100, one per second of source. See videos.peaks. */
  peaks?: number[] | null
}

/** One rendered output file for a clip, in one aspect ratio. */
export interface Render {
  ratio: Ratio
  /** Signed, expiring URL. Null until the render is ready. */
  url: string | null
  thumbUrl: string | null
  width: number | null
  height: number | null
  sizeBytes: number | null
  status: 'pending' | 'rendering' | 'ready' | 'failed'
}

export interface Clip {
  /** Server uuid. The prototype used an array index, which no longer survives a re-cut. */
  id: string
  /** Ordinal within the job, for display order and file naming. */
  idx: number
  /** Headline shown on the card. */
  t: string
  /** In / out point in the source, in seconds. */
  s: number
  e: number
  /** Hook score, 0-100. */
  sc: number
  /** Transcript snippet around the moment. */
  sn: string
  /** Suggested caption for posting. */
  cap: string
  /** The pre-wrapped two-line hook shown on the card. */
  line: string
  status: 'pending' | 'rendering' | 'ready' | 'failed'
  /** One entry per requested aspect ratio. */
  renders: Partial<Record<Ratio, Render>>

  /**
   * The editor's assets, or null for a clip made before they existed.
   *
   * The source video is not kept after a job, so without these the editor has
   * nothing to play and falls back to a placeholder. `proxyUrl` is a signed,
   * range-servable cut of the timeline window; `stripUrl` is the filmstrip.
   */
  proxyUrl: string | null
  stripUrl: string | null
  /** RMS levels 0-100, one per waveform bar. */
  peaks: number[] | null
  /**
   * The stretch of source the proxy covers. Authoritative — the window clamps
   * at both ends of the video, so recomputing it would be wrong for any clip
   * near the start or the end.
   */
  win: { start: number; span: number } | null

  /** Local-only: whether the card is ticked for download. */
  selected: boolean
}

/** One transcript line as the editor shows it. */
export interface TranscriptLine {
  start: number
  end: number
  text: string
}

/** A job on the projects screen, running or finished. */
export interface Project {
  id: string
  title: string
  /** Carried inline: a real project cannot be a key into a fixtures object. */
  source: Source
  clipCount: number
  /** Epoch ms when the job finished, or when it started if it has not. */
  createdAt: number

  /**
   * Where this project is up to, so the row can show its own progress.
   *
   * The list used to be finished-projects-only, and a running job was visible
   * only through the single global banner -- which shows ONE job, whichever
   * the session last touched. Start two projects, or come back on another
   * device, and the work in flight was invisible on the one screen that lists
   * work.
   *
   * Mirrors ProjectDTO in shared/types.ts, which is what /api/projects sends.
   */
  status: JobStatus
  /** Human sub-step, e.g. "Rendering 3 of 12". Null before the first write. */
  stage: string | null
  /** 0-100, the same number the banner shows. */
  progress: number
}

/**
 * A moment the model suggests but nobody has clipped yet. Mirrors
 * RecommendationDTO in shared/types.ts.
 *
 * Field names are spelled out rather than terse like Clip's `t`/`s`/`e`. Clip
 * is terse because renaming its fields would touch every screen carried over
 * from the prototype; nothing obliges a new type to inherit that.
 */
export interface Recommendation {
  /** Position within its round. What POST /jobs/:id/clips takes as `indices`. */
  idx: number
  title: string
  start: number
  end: number
  score: number
  snippet: string
  caption: string
  line: string
  /** An existing clip already covers this stretch. Server-computed per request. */
  taken: boolean
}

/** One exchange: what was asked, and what came back. */
export interface RecommendationRound {
  id: string
  /** Null for the opening round, which came free with the job's own analysis. */
  message: string | null
  candidates: Recommendation[]
  createdAt: string
}
