/**
 * Deleting a project, against a real Postgres.
 *
 * The whole point is a soft delete: the project must vanish from the user's list
 * and stop being reachable, while its row survives so the monthly quota cannot be
 * reset by deleting yesterday's work. That is a property of the SQL, so the test
 * has to run the SQL.
 *
 * Opt-in, because it needs the database up:
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test projects.delete
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported inside beforeAll, not at the top: db/index.ts pulls in env.ts, which
// exits the process when .env is absent. A skipped test must stay importable.
let db: (typeof import('./db/index.ts'))['db']
let users: (typeof import('./db/index.ts'))['users']
let videos: (typeof import('./db/index.ts'))['videos']
let jobs: (typeof import('./db/index.ts'))['jobs']
let clips: (typeof import('./db/index.ts'))['clips']
let ownedJob: (typeof import('./ownership.ts'))['ownedJob']
let quotaUsage: (typeof import('./ownership.ts'))['quotaUsage']
let softDeleteJob: (typeof import('./routes/jobs.ts'))['softDeleteJob']
let listProjects: (typeof import('./routes/jobs.ts'))['listProjects']

let alice = ''
let videoId = ''
let keptJob = ''
let doomedJob = ''
let doomedClip = ''

beforeAll(async () => {
  if (!ENABLED) return

  const dbMod = await import('./db/index.ts')
  ;({ db, users, videos, jobs, clips } = dbMod)
  ;({ ownedJob, quotaUsage } = await import('./ownership.ts'))
  ;({ softDeleteJob, listProjects } = await import('./routes/jobs.ts'))

  const stamp = Date.now()
  const [a] = await db
    .insert(users)
    .values({ googleSub: `test-del-${stamp}`, email: 'del@test.invalid' })
    .returning()
  alice = a.id

  const [v] = await db
    .insert(videos)
    .values({
      url: `https://test.invalid/delete-${stamp}`,
      platform: 'test',
      title: 'Delete fixture',
      durationSeconds: 600,
    })
    .returning()
  videoId = v.id

  const jobValues = {
    userId: alice,
    videoId,
    clipCount: 3,
    lengthPreset: 1,
    formats: { '9:16': true },
    burnSubtitles: true,
    status: 'completed' as const,
    completedAt: new Date(),
  }
  const [kept] = await db.insert(jobs).values(jobValues).returning()
  const [doomed] = await db.insert(jobs).values(jobValues).returning()
  keptJob = kept.id
  doomedJob = doomed.id

  const [c] = await db
    .insert(clips)
    .values({
      jobId: doomedJob,
      idx: 0,
      title: 'Fixture clip',
      startSeconds: 0,
      endSeconds: 30,
      score: 50,
      snippet: 's',
      caption: 'c',
      subtitleLine: 'l',
    })
    .returning()
  doomedClip = c.id
})

afterAll(async () => {
  if (!ENABLED) return
  await db.delete(users).where(inArray(users.id, [alice]))
  await db.delete(videos).where(eq(videos.id, videoId))
})

maybe('both projects are listed before the delete', async () => {
  const before = await listProjects(alice)
  expect(before.map((p) => p.id).sort()).toEqual([keptJob, doomedJob].sort())
})

maybe('a deleted project leaves the list', async () => {
  await softDeleteJob(doomedJob)
  const after = await listProjects(alice)
  expect(after.map((p) => p.id)).toEqual([keptJob])
})

maybe('a deleted project can no longer be opened', async () => {
  expect(await ownedJob(alice, doomedJob)).toBeNull()
  // The surviving one is untouched.
  expect(await ownedJob(alice, keptJob)).not.toBeNull()
})

maybe('the row survives, so the quota is not refunded', async () => {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, doomedJob)).limit(1)
  expect(row).toBeDefined()
  expect(row.deletedAt).toBeInstanceOf(Date)

  const { used } = await quotaUsage(alice, new Date(Date.now() - 86_400_000))
  expect(used).toBe(2)
})

maybe('the clips are really gone, not just hidden', async () => {
  const left = await db.select().from(clips).where(eq(clips.id, doomedClip))
  expect(left).toEqual([])
})
