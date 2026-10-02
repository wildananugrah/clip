/**
 * Caption options and hashtags for posting one clip.
 *
 * Synchronous and in the API, for the reason recommendations.ts gives: the
 * worker runs one job at a time, and a button that waits behind a render is not
 * a button. The transcript is already in Postgres, so this is one model call
 * and an update.
 *
 * Behind recommendationsGate rather than a flag of its own. Both features are
 * the API spending on the model per click, and the gate is the lever for
 * stopping that bill -- a second lever that had to be remembered would be one
 * that got forgotten.
 */
import { Hono } from 'hono'
import { eq, desc } from 'drizzle-orm'
import { db, clips, jobs, videos, transcripts } from '../db/index.ts'
import { ownedClip } from '../ownership.ts'
import { recommendationsGate } from '../recommendationsGate.ts'
import { recommendationConfig } from '../env.ts'
import { buildSocialPrompt, clipTranscript } from '../../../shared/socialCopy.ts'
import { requestSocialCopy, type OpenRouterConfig } from '../../../shared/openrouter.ts'
import type { SocialCopy } from '../../../shared/schema.ts'
import type { ClipSourceDTO } from '../../../shared/types.ts'

export const socialRoutes = new Hono()

/**
 * Injection seam for tests, as RecommendDeps is. `config` is here too because
 * recommendationConfig is fixed when env.ts loads, and the 503 path has to be
 * reachable without a second process.
 */
export interface SocialDeps {
  fetchImpl?: typeof fetch
  config?: OpenRouterConfig | null
}
let deps: SocialDeps = {}
export function setSocialDeps(d: SocialDeps) {
  deps = d
}

/**
 * What was written last time, or null, and the source to credit. Free: never
 * asks the model, so the credit is there even when captions cannot be written.
 */
socialRoutes.get('/:id/social', recommendationsGate, async (c) => {
  const clip = await ownedClip(c.get('user').id, c.req.param('id'))
  if (!clip) return c.json({ error: 'Clip not found' }, 404)

  const [source]: ClipSourceDTO[] = await db
    .select({
      channel: videos.uploader,
      platform: videos.platform,
      title: videos.title,
      url: videos.url,
    })
    .from(jobs)
    .innerJoin(videos, eq(videos.id, jobs.videoId))
    .where(eq(jobs.id, clip.jobId))
    .limit(1)

  return c.json({ social: clip.social ?? null, source: source ?? null })
})

/** Write a fresh set, replacing any saved one. */
socialRoutes.post('/:id/social', recommendationsGate, async (c) => {
  // Ownership first: a stranger's clip id must be a 404 before anything is spent.
  const clip = await ownedClip(c.get('user').id, c.req.param('id'))
  if (!clip) return c.json({ error: 'Clip not found' }, 404)

  const config = deps.config !== undefined ? deps.config : recommendationConfig
  if (!config) {
    return c.json({ error: 'Caption suggestions are not configured on this server.' }, 503)
  }

  const [job] = await db.select().from(jobs).where(eq(jobs.id, clip.jobId)).limit(1)
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const [[video], [transcript]] = await Promise.all([
    db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1),
    db
      .select()
      .from(transcripts)
      .where(eq(transcripts.videoId, job.videoId))
      .orderBy(desc(transcripts.createdAt))
      .limit(1),
  ])
  if (!video) return c.json({ error: 'Source video is missing' }, 404)

  // The words are what the captions are written from. Without them the model
  // would be guessing from a headline, which is worse than saying so.
  if (!transcript) {
    return c.json({ error: 'Regenerate this project to enable caption suggestions.' }, 409)
  }
  const words = clipTranscript(transcript.segments, clip.startSeconds, clip.endSeconds)
  if (!words) {
    return c.json({ error: 'Nothing is said in this clip, so there is nothing to write from.' }, 409)
  }

  let written: { captions: string[]; hashtags: string[] }
  try {
    written = await requestSocialCopy({
      prompt: buildSocialPrompt({
        clipTitle: clip.title,
        videoTitle: video.title,
        transcript: words,
        language: transcript.language,
      }),
      config,
      fetchImpl: deps.fetchImpl,
    })
  } catch (e) {
    // Logged in full, answered in general: the upstream body is OpenRouter's
    // words for us, not for the person who pressed the button.
    console.error('[social] model call failed:', (e as Error).message)
    return c.json({ error: 'Could not write captions right now. Try again in a moment.' }, 502)
  }

  const social: SocialCopy = { ...written, createdAt: new Date().toISOString() }
  await db.update(clips).set({ social }).where(eq(clips.id, clip.id))

  return c.json({ social })
})
