/**
 * Caption and hashtag suggestions per clip, against a real Postgres.
 *
 * The properties worth a database: ownership is decided by SQL (a stranger's
 * clip must 404 before any money is spent), the model only ever reads the words
 * inside the clip, and what it wrote is saved so reopening costs nothing.
 *
 * The model is a stub through setSocialDeps, so no OPENROUTER_API_KEY is needed
 * and every call is counted.
 *
 * Opt-in, because it needs the database up. Never point this at production:
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=<throwaway .env> test social
 */
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { eq, inArray } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported inside beforeAll: db/index.ts pulls in env.ts, which exits the
// process when .env is absent. A skipped test must stay importable.
let db: (typeof import('../db/index.ts'))['db']
let users: (typeof import('../db/index.ts'))['users']
let videos: (typeof import('../db/index.ts'))['videos']
let jobs: (typeof import('../db/index.ts'))['jobs']
let clips: (typeof import('../db/index.ts'))['clips']
let transcripts: (typeof import('../db/index.ts'))['transcripts']
let setSocialDeps: (typeof import('./social.ts'))['setSocialDeps']

const CONFIG = { apiKey: 'k', baseUrl: 'https://or.test/api/v1', model: 'm' }

let app: Hono
let owner = ''
let stranger = ''
let videoId = ''
let bareVideoId = ''
let clipId = ''
let silentClipId = ''
let noTranscriptClipId = ''

/** What the stub model was sent, one entry per call. */
let prompts: string[] = []
let reply = '{"captions":["Stop billing hours.","Why hourly pricing fails"],"hashtags":["#pricing","startup"]}'

const stubFetch = (async (_url: string, init: RequestInit) => {
  prompts.push(JSON.parse(init.body as string).messages[0].content)
  return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }))
}) as unknown as typeof fetch

const as = (userId: string) => {
  const a = new Hono()
  a.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'social@test.invalid',
      name: null,
      pictureUrl: null,
      monthlyJobLimit: null,
      storageLimitBytes: null,
      projectLimit: null,
    })
    await next()
  })
  return a
}

beforeAll(async () => {
  if (!ENABLED) return
  ;({ db, users, videos, jobs, clips, transcripts } = await import('../db/index.ts'))
  const social = await import('./social.ts')
  setSocialDeps = social.setSocialDeps
  const { env } = await import('../env.ts')
  env.RECOMMENDATIONS_ENABLED = true

  const stamp = Date.now()
  const [a] = await db
    .insert(users)
    .values({ googleSub: `test-social-a-${stamp}`, email: 'social-a@test.invalid' })
    .returning()
  const [b] = await db
    .insert(users)
    .values({ googleSub: `test-social-b-${stamp}`, email: 'social-b@test.invalid' })
    .returning()
  owner = a.id
  stranger = b.id

  const video = async (suffix: string) => {
    const [v] = await db
      .insert(videos)
      .values({
        url: `https://test.invalid/social-${suffix}-${stamp}`,
        platform: 'test',
        title: 'Founder podcast',
        durationSeconds: 600,
        uploader: suffix === 'a' ? 'Close The Door' : null,
      })
      .returning()
    return v.id
  }
  videoId = await video('a')
  bareVideoId = await video('b')

  await db.insert(transcripts).values({
    videoId,
    language: 'en',
    segments: [
      { start: 0, end: 10, text: 'Welcome to the show.' },
      { start: 30, end: 40, text: 'Most founders price by the hour.' },
      { start: 40, end: 50, text: 'That is the mistake.' },
      { start: 100, end: 110, text: 'Thanks to our sponsor.' },
    ],
  })

  const job = async (vid: string) => {
    const [row] = await db
      .insert(jobs)
      .values({
        userId: owner,
        videoId: vid,
        clipCount: 2,
        lengthPreset: 1,
        formats: { '9:16': true },
        burnSubtitles: true,
        status: 'completed',
        completedAt: new Date(),
      })
      .returning()
    return row.id
  }
  const clip = async (jobId: string, start: number, end: number) => {
    const [row] = await db
      .insert(clips)
      .values({
        jobId,
        idx: 0,
        title: 'The pricing mistake',
        startSeconds: start,
        endSeconds: end,
        score: 80,
        snippet: 's',
        caption: 'c',
        subtitleLine: 'l',
        status: 'ready',
      })
      .returning()
    return row.id
  }

  const withTranscript = await job(videoId)
  clipId = await clip(withTranscript, 30, 50)
  silentClipId = await clip(withTranscript, 60, 90)
  noTranscriptClipId = await clip(await job(bareVideoId), 0, 30)

  app = new Hono()
  app.route('/', as(owner).route('/api/clips', social.socialRoutes))
})

beforeEach(() => {
  if (!ENABLED) return
  prompts = []
  setSocialDeps({ fetchImpl: stubFetch, config: CONFIG })
})

afterAll(async () => {
  if (!ENABLED) return
  // Users cascade to jobs, which cascade to clips. Videos cascade to transcripts.
  await db.delete(users).where(inArray(users.id, [owner, stranger]))
  await db.delete(videos).where(inArray(videos.id, [videoId, bareVideoId]))
})

const post = (id: string, a: Hono = app) => a.request(`/api/clips/${id}/social`, { method: 'POST' })

maybe('GET answers null before anything was written, with the source to credit', async () => {
  const res = await app.request(`/api/clips/${clipId}/social`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.social).toBeNull()
  expect(body.source).toEqual({
    channel: 'Close The Door',
    platform: 'test',
    title: 'Founder podcast',
    url: expect.stringContaining('https://test.invalid/social-a-'),
  })
  expect(prompts).toHaveLength(0)
})

maybe('the source credit has no channel when the extractor gave none', async () => {
  const body = (await (await app.request(`/api/clips/${noTranscriptClipId}/social`)).json()) as any
  expect(body.source.channel).toBeNull()
  expect(body.source.title).toBe('Founder podcast')
})

maybe('POST writes from the words inside the clip only, and saves them', async () => {
  const res = await post(clipId)
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.social.captions).toEqual(['Stop billing hours.', 'Why hourly pricing fails'])
  expect(body.social.hashtags).toEqual(['pricing', 'startup'])
  expect(typeof body.social.createdAt).toBe('string')

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Most founders price by the hour.')
  expect(prompts[0]).not.toContain('Thanks to our sponsor.')
  expect(prompts[0]).not.toContain('Welcome to the show.')
  expect(prompts[0]).toContain('"en"')

  const [row] = await db.select().from(clips).where(eq(clips.id, clipId))
  expect(row.social?.captions).toEqual(body.social.captions)
})

maybe('GET then returns the saved set without asking the model', async () => {
  const res = await app.request(`/api/clips/${clipId}/social`)
  const body = (await res.json()) as any
  expect(body.social.hashtags).toEqual(['pricing', 'startup'])
  expect(prompts).toHaveLength(0)
})

maybe('POST again replaces the saved set', async () => {
  reply = '{"captions":["A fresh angle."],"hashtags":["fresh"]}'
  const body = (await (await post(clipId)).json()) as any
  expect(body.social.captions).toEqual(['A fresh angle.'])
  const [row] = await db.select().from(clips).where(eq(clips.id, clipId))
  expect(row.social?.hashtags).toEqual(['fresh'])
})

maybe("a stranger's clip is a 404, and costs nothing", async () => {
  const strangerApp = new Hono()
  const { socialRoutes } = await import('./social.ts')
  strangerApp.route('/', as(stranger).route('/api/clips', socialRoutes))

  expect((await strangerApp.request(`/api/clips/${clipId}/social`)).status).toBe(404)
  expect((await post(clipId, strangerApp)).status).toBe(404)
  expect(prompts).toHaveLength(0)
})

maybe('503 when the server has no model configured', async () => {
  setSocialDeps({ fetchImpl: stubFetch, config: null })
  const res = await post(clipId)
  expect(res.status).toBe(503)
  expect(prompts).toHaveLength(0)
})

maybe('409 when the video has no transcript', async () => {
  const res = await post(noTranscriptClipId)
  expect(res.status).toBe(409)
  expect(prompts).toHaveLength(0)
})

maybe('409 when nothing is said inside the clip', async () => {
  const res = await post(silentClipId)
  expect(res.status).toBe(409)
  expect(prompts).toHaveLength(0)
})

maybe('a model failure is a 502 with a message for people, and saves nothing', async () => {
  const before = (await db.select().from(clips).where(eq(clips.id, clipId)))[0].social
  setSocialDeps({
    fetchImpl: (async () => new Response('upstream exploded', { status: 500 })) as any,
    config: CONFIG,
  })
  const res = await post(clipId)
  expect(res.status).toBe(502)
  const body = (await res.json()) as any
  expect(body.error).not.toContain('upstream exploded')
  const after = (await db.select().from(clips).where(eq(clips.id, clipId)))[0].social
  expect(after).toEqual(before)
})
