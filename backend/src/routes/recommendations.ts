/**
 * Suggested moments for a finished project, and the chat that reshapes them.
 *
 * WHY THIS RUNS IN THE API AND NOT THE WORKER: WORKER_CONCURRENCY is 1, because
 * whisper and x264 each want all four cores. A chat turn queued behind a render
 * waits for the render -- minutes at best, most of an hour for a long source,
 * which is not a conversation. Recommendations need no CPU and no disk: the
 * transcript is already in Postgres, cached per video, so a turn is one HTTP
 * call and an insert. So these are synchronous and there is no SSE.
 *
 * Nothing the model returns is trusted here either. validateRanges is the same
 * trust boundary the pipeline uses, and the ranges that survive it are then
 * checked against what the user already has.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { eq, asc, desc } from 'drizzle-orm'
import { db, clips, jobs, videos, transcripts, recommendationRounds } from '../db/index.ts'
import { ownedJob, storageUsage } from '../ownership.ts'
import { enqueueRecut } from '../queue.ts'
import { recommendationsGate } from '../recommendationsGate.ts'
import { toClipDTOs } from '../mappers.ts'
import { quotaVerdict } from '../quota.ts'
import { nextIdxFor, trimError } from './clips.ts'
import { env, recommendationConfig } from '../env.ts'
import { buildRecommendPrompt } from '../../../shared/clipPrompt.ts'
import { requestClips } from '../../../shared/openrouter.ts'
import { validateRanges, overlapsAny, type Range } from '../../../shared/clipRanges.ts'
import {
  isTerminal,
  MAX_CHAT_CHARS,
  RECOMMEND_PER_ROUND,
  type RecommendationDTO,
  type RecommendationRoundDTO,
} from '../../../shared/types.ts'
import type { Clip, Job, RecommendationRound } from '../../../shared/schema.ts'

export const recommendationRoutes = new Hono()

/**
 * Injection seam for tests, mirroring SubscribeDeps in frontend/src/lib/api.ts.
 * A route test should be able to assert the prompt that was built without a
 * network, and without a real OPENROUTER_API_KEY in CI.
 */
export interface RecommendDeps {
  fetchImpl?: typeof fetch
}
let deps: RecommendDeps = {}
export function setRecommendDeps(d: RecommendDeps) {
  deps = d
}

const messageBody = z.object({
  message: z.string().trim().min(1, 'Say what you are looking for.').max(MAX_CHAT_CHARS),
})

const createBody = z.object({
  roundId: z.string().uuid(),
  indices: z.array(z.number().int().nonnegative()).min(1, 'Pick at least one moment.'),
})

/** A round as the wire sees it, with `taken` resolved against current clips. */
function toRoundDTO(round: RecommendationRound, existing: Range[]): RecommendationRoundDTO {
  return {
    id: round.id,
    message: round.userMessage,
    createdAt: round.createdAt.toISOString(),
    candidates: round.candidates.map(
      (c, idx): RecommendationDTO => ({
        idx,
        title: c.title,
        start: c.start,
        end: c.end,
        score: c.score,
        snippet: c.snippet,
        caption: c.caption,
        line: c.line,
        taken: overlapsAny(c, existing),
      }),
    ),
  }
}

const clipRanges = (rows: Clip[]): Range[] =>
  rows.map((c) => ({ start: c.startSeconds, end: c.endSeconds }))

/**
 * A job mid-render is about to rewrite its own clips, so neither suggesting
 * against them nor adding to them is safe.
 *
 * The test is IN FLIGHT, not 'completed' -- the same distinction POST
 * /clips/:id/copy makes, and for the same reason: a project cancelled after its
 * clips rendered is finished with, and refusing it here would strand clips the
 * user can see.
 */
function notReady(job: Job): string | null {
  return isTerminal(job.status) ? null : 'Wait for the job to finish.'
}

recommendationRoutes.get('/:id/recommendations', recommendationsGate, async (c) => {
  const job = await ownedJob(c.get('user').id, c.req.param('id'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const [rounds, existing] = await Promise.all([
    db
      .select()
      .from(recommendationRounds)
      .where(eq(recommendationRounds.jobId, job.id))
      .orderBy(asc(recommendationRounds.createdAt)),
    db.select().from(clips).where(eq(clips.jobId, job.id)),
  ])

  const used = clipRanges(existing)
  return c.json({ rounds: rounds.map((r) => toRoundDTO(r, used)) })
})

/** Ask for a different set. Replaces the live list; earlier rounds are kept. */
recommendationRoutes.post('/:id/recommendations', recommendationsGate, async (c) => {
  const job = await ownedJob(c.get('user').id, c.req.param('id'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  if (!recommendationConfig) {
    return c.json({ error: 'Recommendations are not configured on this server.' }, 503)
  }

  const stop = notReady(job)
  if (stop) return c.json({ error: stop }, 409)

  const parsed = messageBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }

  const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
  if (!video) return c.json({ error: 'Source video is missing' }, 404)

  const [transcript] = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.videoId, job.videoId))
    .orderBy(desc(transcripts.createdAt))
    .limit(1)

  // The transcript is what the model reads. Without one there is nothing to
  // recommend from, and this route cannot make one -- that is the worker's job.
  if (!transcript) {
    return c.json({ error: 'Regenerate this project to enable recommendations.' }, 409)
  }

  const [existing, priorRounds] = await Promise.all([
    db.select().from(clips).where(eq(clips.jobId, job.id)),
    db
      .select()
      .from(recommendationRounds)
      .where(eq(recommendationRounds.jobId, job.id))
      .orderBy(asc(recommendationRounds.createdAt)),
  ])

  // Everything already on screen: the user's clips, and every moment suggested
  // so far. Repeating any of them is the one thing a second round must not do.
  const avoid: Range[] = [
    ...clipRanges(existing),
    ...priorRounds.flatMap((r) => r.candidates.map((x) => ({ start: x.start, end: x.end }))),
  ]

  const messages = [
    ...priorRounds.map((r) => r.userMessage).filter((m): m is string => !!m),
    parsed.data.message,
  ]

  const candidates = await requestClips({
    prompt: buildRecommendPrompt({
      segments: transcript.segments,
      durationSeconds: video.durationSeconds,
      lengthIdx: job.lengthPreset,
      title: video.title,
      brief: job.prompt,
      want: RECOMMEND_PER_ROUND,
      avoid,
      messages,
    }),
    config: recommendationConfig,
    fetchImpl: deps.fetchImpl,
  })

  /**
   * Two filters, in this order. validateRanges is the trust boundary -- clamp,
   * snap, fit the length window, drop candidates that overlap EACH OTHER. It
   * cannot drop one that overlaps a clip, because clips were never in the list,
   * so that pass happens here. Asking for more than we keep leaves room for
   * both filters to discard.
   */
  const ranked = validateRanges(candidates, {
    durationSeconds: video.durationSeconds,
    lengthIdx: job.lengthPreset,
    count: RECOMMEND_PER_ROUND * 2,
    segments: transcript.segments,
  })
  const fresh = ranked.filter((r) => !overlapsAny(r, avoid)).slice(0, RECOMMEND_PER_ROUND)

  const [round] = await db
    .insert(recommendationRounds)
    .values({ jobId: job.id, userMessage: parsed.data.message, candidates: fresh })
    .returning()

  return c.json(toRoundDTO(round, clipRanges(existing)), 201)
})

/**
 * Turn chosen recommendations into clips.
 *
 * This is POST /clips/:id/copy with a different source for the range, and it
 * keeps that route's two guards verbatim. recutClip needs no changes to render
 * the rows: it cuts whatever range is on the row it is handed, and its
 * delete-the-previous-renders step is a no-op for a row that has none yet.
 */
recommendationRoutes.post('/:id/clips', recommendationsGate, async (c) => {
  const user = c.get('user')
  const job = await ownedJob(user.id, c.req.param('id'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const stop = notReady(job)
  if (stop) return c.json({ error: stop }, 409)

  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, 400)
  }

  const [round] = await db
    .select()
    .from(recommendationRounds)
    .where(eq(recommendationRounds.id, parsed.data.roundId))
    .limit(1)

  // Scoped to THIS job, not merely to an existing round: a round id belonging
  // to someone else's project must be indistinguishable from one that is made
  // up, or the response confirms it exists.
  if (!round || round.jobId !== job.id) return c.json({ error: 'Round not found' }, 404)

  // Indices, not raw ranges, so a client cannot post timestamps of its own.
  const picked = [...new Set(parsed.data.indices)].map((i) => round.candidates[i])
  if (picked.some((p) => !p)) return c.json({ error: 'That moment is no longer available.' }, 400)

  const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1)
  if (!video) return c.json({ error: 'Source video is missing' }, 404)

  for (const p of picked) {
    const bad = trimError(p.start, p.end, video.durationSeconds)
    if (bad) return c.json({ error: bad }, 400)
  }

  /**
   * Creating clips adds renders, and nothing else bounds how many: the monthly
   * quota counts jobs, and this creates clips inside one that is already paid
   * for. The storage ceiling is the honest limit to apply. Same reasoning, and
   * the same call, as POST /clips/:id/copy.
   */
  const refusal = quotaVerdict({
    activeCount: 0,
    monthlyCount: 0,
    monthlyLimit: Number.POSITIVE_INFINITY,
    storageBytes: await storageUsage(user.id),
    storageLimitBytes: user.storageLimitBytes ?? env.QUOTA_STORAGE_GB * 1024 ** 3,
  })
  if (refusal) return c.json({ error: refusal.message }, refusal.status)

  const siblings = await db.select().from(clips).where(eq(clips.jobId, job.id))
  const base = nextIdxFor(siblings)

  const created = await db
    .insert(clips)
    .values(
      picked.map((p, n) => ({
        jobId: job.id,
        idx: base + n,
        title: p.title,
        startSeconds: p.start,
        endSeconds: p.end,
        score: p.score,
        snippet: p.snippet,
        caption: p.caption,
        subtitleLine: p.line,
        status: 'pending' as const,
      })),
    )
    .returning()

  for (const clip of created) await enqueueRecut({ jobId: job.id, clipId: clip.id })

  return c.json(toClipDTOs(created, []), 201)
})
