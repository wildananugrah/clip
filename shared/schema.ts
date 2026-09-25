/**
 * Drizzle schema. Imported by both backend and worker (and, for its inferred
 * types, the frontend) so the wire contract has exactly one definition.
 *
 * Tier C added `users` and `sessions`. Ownership hangs off ONE column --
 * `jobs.user_id` -- because clips, renders and transcripts all reach a user
 * transitively through it, so there is a single place to get scoping right.
 *
 * `videos` and `transcripts` stay global on purpose: they are a URL-keyed cache
 * of the most expensive stage in the pipeline, and two users clipping the same
 * link should share it.
 */
import { sql } from 'drizzle-orm'
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core'

export const jobStatus = pgEnum('job_status', [
  'pending',
  'downloading',
  'transcribing',
  'analyzing',
  'rendering',
  'completed',
  'failed',
  'cancelled',
])

export const clipStatus = pgEnum('clip_status', ['pending', 'rendering', 'ready', 'failed'])
export const renderStatus = pgEnum('render_status', ['pending', 'rendering', 'ready', 'failed'])

/**
 * Where objects can live. A list, not a single endpoint, so a new bucket can be
 * added without retiring the one already holding clips.
 *
 * Exactly one row is the active write target; every row stays readable forever,
 * which is what lets a clip rendered in the MinIO era keep playing after the
 * writes have moved to S3. The row that owns a key records which backend holds
 * it (see `renders.storage`), so a read never has to guess or probe.
 *
 * Deliberately holds NO credentials. Access keys live in the environment, one
 * pair per id, so a database dump cannot carry object-storage credentials --
 * the same reason `sessions` stores a hash rather than the token.
 */
export const storageBackends = pgTable(
  'storage_backends',
  {
    /** Also derives the env var names, so it is restricted to [a-z0-9-]. */
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    /** Null for real AWS, which is addressed by region rather than endpoint. */
    endpoint: text('endpoint'),
    region: text('region').notNull(),
    bucket: text('bucket').notNull(),
    /** MinIO addresses buckets by path; AWS uses virtual-host style. */
    pathStyle: boolean('path_style').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // One write target, enforced here rather than by the script that flips it: a
  // partial unique index makes "two actives" unrepresentable even by hand.
  (t) => [uniqueIndex('storage_one_active').on(t.isActive).where(sql`${t.isActive}`)],
)

/**
 * A signed-in person. Keyed on Google's `sub` claim rather than email: an
 * account's email address can change, and matching on email would hand the old
 * address's projects to whoever later inherits it. Email is display only.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    googleSub: text('google_sub').notNull().unique(),
    email: text('email').notNull(),
    name: text('name'),
    pictureUrl: text('picture_url'),
    /**
     * Per-user override for the monthly job allowance. Null means "follow
     * QUOTA_JOBS_PER_MONTH", so the global default stays the one place the normal
     * limit is configured and this column only ever names the exceptions.
     *
     * The column keeps its old name from when the allowance was per 24h: a
     * rename would be a migration for no behavioural gain.
     */
    monthlyJobLimit: integer('daily_job_limit'),
    /**
     * Per-user override for the rendered-bytes cap, null to follow
     * QUOTA_STORAGE_GB. bigint because 5 GB in bytes overflows int4.
     */
    storageLimitBytes: bigint('storage_limit_bytes', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_google_sub_idx').on(t.googleSub)],
)

/**
 * A live login. `id` is the SHA-256 of the cookie token, never the token itself,
 * so a database dump cannot be replayed as a session. The user index exists so
 * "log out everywhere" is one DELETE when it is wanted.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

/** A resolved source video. One row per URL; re-analysing the same URL reuses it. */
export const videos = pgTable(
  'videos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    platform: text('platform').notNull(),
    title: text('title').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    /** Uploader / channel, shown in the source card's meta line. */
    uploader: text('uploader'),
    /** Source publish date, ISO. Null when the extractor does not supply one. */
    publishedAt: text('published_at'),
    /** Best available height, e.g. 1080. Drives the "1080p available" meta text. */
    maxHeight: integer('max_height'),

    /**
     * Editor assets for the WHOLE source, built only when someone opens manual
     * mode. Per-video and therefore shared: the second user to edit a popular
     * URL pays nothing, exactly as they already pay nothing for its transcript.
     *
     * All nullable. A null proxyKey means "never built, or evicted" -- the two
     * are indistinguishable on purpose, because the answer to both is the same:
     * rebuild it on demand.
     *
     * These mirror the per-clip asset columns name for name. The difference is
     * span: a clip's proxy covers its 150-second window, these cover the lot.
     */
    proxyKey: text('proxy_key'),
    stripKey: text('strip_key'),
    /**
     * RMS levels 0-100, ONE PER SECOND of source.
     *
     * The same density as the per-clip waveform (150 buckets over a 150-second
     * window), which is what lets one array serve both timelines: the overview
     * downsamples in the browser, and the detail band slices the 150 values its
     * window covers. No second asset, no second encode.
     */
    peaks: jsonb('peaks').$type<number[]>(),
    /** Which backend holds proxyKey and stripKey. See clips.assetStorage. */
    assetStorage: text('asset_storage').references(() => storageBackends.id),
    /**
     * proxy + strip, for the retention budget, which sums this column rather
     * than listing the bucket.
     *
     * `integer` to match clips.proxy_bytes: it overflows past ~2.1GB, which at
     * ~120MB per hour is a 17-hour source. Matching the column it mirrors is
     * worth more than guarding a case the platform cannot produce.
     */
    proxyBytes: integer('proxy_bytes'),
    /**
     * Last time the editor asked for these. THE EVICTION ORDER IS THIS COLUMN --
     * least recently used, so the source being worked on is structurally the
     * last thing eligible to be deleted.
     */
    proxyUsedAt: timestamp('proxy_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('videos_url_idx').on(t.url)],
)

/**
 * One worker host's cached copy of an original download.
 *
 * The problem this solves: opening the editor downloads the source to build a
 * proxy, and saving a trim minutes later needs the same file. Those are two
 * different operations in two different scratch directories, and every
 * operation deletes its own directory on the way out -- so the second one
 * re-downloaded several gigabytes it already had.
 *
 * Reusing the first download directly is the race this replaces: a re-cut that
 * adopted a running job's scratch file lost it the moment that job finished and
 * cleaned up. So the file named here lives OUTSIDE any operation's directory,
 * in one nobody owns and only the retention sweep deletes.
 *
 * KEYED BY (video_id, host_id), NOT BY VIDEO ALONE. `path` is absolute on one
 * machine's disk, and workers may run on several (docker-compose.worker.yml,
 * each with its own volume). One row per video would let host B overwrite host
 * A's path, leaving A's multi-gigabyte file with nothing pointing at it and no
 * sweep able to find it.
 */
export const videoSourceCache = pgTable(
  'video_source_cache',
  {
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    /** Which worker's disk holds it. See the table comment. */
    hostId: text('host_id').notNull(),
    /** Absolute path on that host. Only ever read when host_id matches. */
    path: text('path').notNull(),
    /**
     * Size on disk, from stat() after the download lands.
     *
     * `bigint` rather than the `integer` the proxy columns use: this is a
     * full-resolution original, and a four-hour 1080p source is comfortably
     * past the 2.1GB an integer can count.
     */
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    /** Last operation that read or wrote it. The eviction order. */
    usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * How many operations are holding this file open right now.
     *
     * THE SWEEP MUST NOT DELETE A ROW WHOSE COUNT IS NOT ZERO: that is a file
     * some render is reading, and taking it away fails that render on a file it
     * did not create -- precisely the bug the old scratch-path ownership check
     * existed to prevent. Incremented and decremented in SQL so two operations
     * cannot lose an update between them.
     *
     * A worker that dies mid-render leaves this above zero forever, which would
     * make the row immortal. Each host zeroes its OWN rows at startup, which is
     * safe because a booting worker has claimed no work yet.
     */
    refs: integer('refs').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.videoId, t.hostId] }),
    // Every sweep reads one host's rows oldest-first.
    index('video_source_cache_host_used_idx').on(t.hostId, t.usedAt),
  ],
)

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The single owner column. Every ownership check in the API resolves to this
     * one, so a clip, render or download is reachable only through its job.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    status: jobStatus('status').notNull().default('pending'),
    /** Human-readable sub-step, e.g. "Transcribing (12m of 48m)". */
    stage: text('stage'),
    progress: integer('progress').notNull().default(0),
    error: text('error'),

    // --- options captured from the setup screen ---
    clipCount: integer('clip_count').notNull(),
    /** 0 = <30s, 1 = 30-60s, 2 = 60-90s. Matches the frontend LENGTHS array. */
    lengthPreset: integer('length_preset').notNull(),
    /** e.g. {"9:16": true, "1:1": true, "4:5": false} */
    formats: jsonb('formats').$type<Record<string, boolean>>().notNull(),
    burnSubtitles: boolean('burn_subtitles').notNull().default(true),
    /**
     * What the user asked the model to look for, in their own words -- e.g.
     * "only the parts about pricing". Steers WHICH moments get picked; the
     * length, overlap and duration rules still bind regardless of what it says.
     *
     * NULL rather than '' so "no brief" is one value, not two. Lives on the job
     * rather than the video because two people clipping the same URL want
     * different things from it -- and because regenerate re-runs this same row,
     * which is what makes Redo honour the brief without any extra plumbing.
     */
    prompt: text('prompt'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * Set when the user deletes the project. The row outlives the delete on
     * purpose: quotaUsage counts rows, so a hard delete would hand back a monthly
     * slot and make the cap resettable by clearing your history. The clips and
     * their S3 objects are really gone by the time this is stamped.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_created_idx').on(t.createdAt),
    // Both quota counts and every project listing filter on the owner.
    index('jobs_user_idx').on(t.userId),
  ],
)

/**
 * Keyed by video, not job, so a regenerate or a single-clip re-cut reuses the
 * transcript instead of paying 15-45 minutes of CPU for it twice.
 */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    language: text('language'),
    srtKey: text('srt_key'),
    /** Which backend holds srtKey. See renders.storage. */
    storage: text('storage')
      .notNull()
      .default('minio')
      .references(() => storageBackends.id),
    segments: jsonb('segments').$type<TranscriptSegment[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('transcripts_video_idx').on(t.videoId)],
)

export const clips = pgTable(
  'clips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Ordinal within the job, for stable display order and file naming. */
    idx: integer('idx').notNull(),
    title: text('title').notNull(),
    startSeconds: doublePrecision('start_seconds').notNull(),
    endSeconds: doublePrecision('end_seconds').notNull(),
    /** Hook score 0-100, as returned by the model. */
    score: integer('score').notNull(),
    /** Transcript excerpt around the moment. */
    snippet: text('snippet').notNull(),
    /** Suggested social caption. */
    caption: text('caption').notNull(),
    /** Pre-wrapped two-line hook shown on the card (distinct from burned subs). */
    subtitleLine: text('subtitle_line').notNull(),
    status: clipStatus('status').notNull().default('pending'),
    error: text('error'),

    /**
     * Editor assets: a low-resolution proxy of the timeline window, a filmstrip
     * sprite cut from it, and its audio peaks.
     *
     * All nullable, and a null proxyKey is the signal that a clip predates the
     * editor work -- its screen falls back to the hatched placeholder rather
     * than breaking. They exist because the source video does not survive its
     * job (pipeline.ts removes the work dir on every exit path and never
     * uploads the source), so there would otherwise be nothing to play.
     */
    proxyKey: text('proxy_key'),
    /**
     * Size of the proxy object.
     *
     * Recorded at upload the way renders.sizeBytes is, because a Range request
     * has to be resolved against a length and the storage interface exposes no
     * HEAD -- without it the editor's scrubber cannot seek.
     */
    proxyBytes: integer('proxy_bytes'),
    stripKey: text('strip_key'),
    /** RMS levels 0-100 across the window, one per timeline bucket. */
    peaks: jsonb('peaks').$type<number[]>(),
    /**
     * The exact offsets the proxy was encoded with.
     *
     * STORED, not recomputed. The window clamps at both ends of the source -- a
     * clip at t=10 cannot have a full lead-in, and one near the end cannot have
     * a full span -- so a frontend recomputing `start - LEAD_IN` would map the
     * timeline to the wrong frames for precisely those clips.
     */
    windowStart: doublePrecision('window_start'),
    windowSpan: doublePrecision('window_span'),
    /** Which backend holds proxyKey and stripKey. See renders.storage. */
    assetStorage: text('asset_storage')
      .notNull()
      .default('minio')
      .references(() => storageBackends.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clips_job_idx').on(t.jobId)],
)

/**
 * One row per (clip, aspect ratio). Separate table because the setup screen
 * allows 9:16 AND 1:1 AND 4:5 simultaneously -- the prototype's flat Clip type
 * had nowhere to put three files.
 */
export const renders = pgTable(
  'renders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clipId: uuid('clip_id')
      .notNull()
      .references(() => clips.id, { onDelete: 'cascade' }),
    ratio: text('ratio').notNull(),
    s3Key: text('s3_key'),
    thumbKey: text('thumb_key'),
    width: integer('width'),
    height: integer('height'),
    sizeBytes: integer('size_bytes'),
    /**
     * Which backend holds s3Key and thumbKey. Written in the same statement as
     * those keys, so a key and its location cannot disagree. The 'minio'
     * default is a fact about history, not a guess: every row that predates the
     * registry came from MinIO.
     */
    storage: text('storage')
      .notNull()
      .default('minio')
      .references(() => storageBackends.id),
    durationSeconds: doublePrecision('duration_seconds'),
    status: renderStatus('status').notNull().default('pending'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('renders_clip_idx').on(t.clipId)],
)

/**
 * One exchange in a project's "find me other moments" conversation.
 *
 * The chat history IS this table ordered by createdAt, and the list the user
 * currently sees is the newest row's `candidates`. A separate messages table
 * would hold one row per round carrying one nullable string, joined back to the
 * round it already belongs to.
 *
 * No userId: ownership resolves through jobId -> jobs.userId, the single owner
 * column every check in the API goes through.
 *
 * No "was this turned into a clip" column either. The results screen already
 * loads the job's clips, so that question is an overlap test answered where it
 * is asked -- a column would be a second copy of a fact, free to drift from the
 * first.
 */
export const recommendationRounds = pgTable(
  'recommendation_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /**
     * What the user asked for, or NULL for the opening round.
     *
     * NULL is not "they said nothing": it marks the round that came free from
     * the analyse stage's surplus, which no one asked for. The UI needs to tell
     * the two apart to know whether to draw a chat bubble.
     */
    userMessage: text('user_message'),
    /** Validated ranges, same shape the analyse stage produces. */
    candidates: jsonb('candidates').$type<RecommendedCandidate[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recommendation_rounds_job_idx').on(t.jobId)],
)

/**
 * Structurally identical to Candidate in clipRanges.ts, declared here so the
 * schema does not import the validator. Kept in step by the insert site, which
 * writes Candidate values straight into this column.
 */
export interface RecommendedCandidate {
  title: string
  start: number
  end: number
  score: number
  snippet: string
  caption: string
  line: string
}

/** One whisper segment. Times are seconds from the start of the source. */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export type User = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Video = typeof videos.$inferSelect
export type Job = typeof jobs.$inferSelect
export type Transcript = typeof transcripts.$inferSelect
export type Clip = typeof clips.$inferSelect
export type Render = typeof renders.$inferSelect
export type RecommendationRound = typeof recommendationRounds.$inferSelect
