/**
 * The project cap counts what the Projects screen shows, against a real Postgres.
 *
 * The count and the list share one filter (projectsOf). If they drifted, a user
 * could be told they are at the limit while seeing fewer projects than that --
 * with nothing on screen to delete that would free a slot.
 *
 * Opt-in, because it needs the database up:
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test projects.limit
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported inside beforeAll: db/index.ts pulls in env.ts, which exits the
// process when .env is absent. A skipped test must stay importable.
let db: (typeof import('./db/index.ts'))['db']
let users: (typeof import('./db/index.ts'))['users']
let videos: (typeof import('./db/index.ts'))['videos']
let jobs: (typeof import('./db/index.ts'))['jobs']
let clips: (typeof import('./db/index.ts'))['clips']
let countProjects: (typeof import('./ownership.ts'))['countProjects']
let listProjects: (typeof import('./routes/jobs.ts'))['listProjects']
let softDeleteJob: (typeof import('./routes/jobs.ts'))['softDeleteJob']

let owner = ''
let stranger = ''
let videoId = ''
let withClips = ''
let running = ''

beforeAll(async () => {
  if (!ENABLED) return

  ;({ db, users, videos, jobs, clips } = await import('./db/index.ts'))
  ;({ countProjects } = await import('./ownership.ts'))
  ;({ listProjects, softDeleteJob } = await import('./routes/jobs.ts'))

  const stamp = Date.now()
  const [a] = await db
    .insert(users)
    .values({ googleSub: `test-limit-a-${stamp}`, email: 'limit-a@test.invalid' })
    .returning()
  const [b] = await db
    .insert(users)
    .values({ googleSub: `test-limit-b-${stamp}`, email: 'limit-b@test.invalid' })
    .returning()
  owner = a.id
  stranger = b.id

  const [v] = await db
    .insert(videos)
    .values({
      url: `https://test.invalid/limit-${stamp}`,
      platform: 'test',
      title: 'Limit fixture',
      durationSeconds: 600,
    })
    .returning()
  videoId = v.id

  const job = async (
    userId: string,
    status: 'completed' | 'failed' | 'rendering',
    opts: { clip?: boolean; deleted?: boolean } = {},
  ) => {
    const [row] = await db
      .insert(jobs)
      .values({
        userId,
        videoId,
        clipCount: 2,
        lengthPreset: 1,
        formats: { '9:16': true },
        burnSubtitles: true,
        status,
        completedAt: status === 'rendering' ? null : new Date(),
        deletedAt: opts.deleted ? new Date() : null,
      })
      .returning()
    if (opts.clip) {
      await db.insert(clips).values({
        jobId: row.id,
        idx: 0,
        title: 'Fixture clip',
        startSeconds: 0,
        endSeconds: 30,
        score: 50,
        snippet: 's',
        caption: 'c',
        subtitleLine: 'l',
        status: 'ready',
      })
    }
    return row.id
  }

  withClips = await job(owner, 'completed', { clip: true })
  running = await job(owner, 'rendering')
  // Neither of these is on the owner's screen, so neither may take a slot.
  await job(owner, 'failed')
  await job(owner, 'completed', { clip: true, deleted: true })
  await job(stranger, 'completed', { clip: true })
})

afterAll(async () => {
  if (!ENABLED) return
  // Users cascade to jobs, which cascade to clips.
  await db.delete(users).where(inArray(users.id, [owner, stranger]))
  await db.delete(videos).where(eq(videos.id, videoId))
})

maybe('counts the finished project and the running one, nothing else', async () => {
  expect(await countProjects(owner)).toBe(2)
})

maybe('the count is exactly what the Projects screen lists', async () => {
  const listed = await listProjects(owner)
  expect(listed.map((p) => p.id).sort()).toEqual([withClips, running].sort())
  expect(await countProjects(owner)).toBe(listed.length)
})

maybe('deleting a project gives its slot back at once', async () => {
  await softDeleteJob(withClips)
  expect(await countProjects(owner)).toBe(1)
})

maybe("another user's projects are not counted", async () => {
  expect(await countProjects(stranger)).toBe(1)
})
