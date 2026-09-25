/**
 * Per-user isolation, against a real Postgres. Scoping is the whole point of
 * Tier C, and it cannot be proved with pure functions -- the question is whether
 * the SQL filters, so the test has to run the SQL.
 *
 * Opt-in, because it needs the database up:
 *
 * The Google pair is dummied rather than read from .env: these tests never
 * reach Google, and the real .env should not carry placeholder credentials.
 *
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x RUN_DB_TESTS=1 \
 *     bun --env-file=../.env test ownership
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported inside beforeAll, not at the top: db/index.ts pulls in env.ts, which
// exits the process when .env is absent. A skipped test must stay importable.
let db: typeof import('./db/index.ts')['db']
let users: typeof import('./db/index.ts')['users']
let videos: typeof import('./db/index.ts')['videos']
let jobs: typeof import('./db/index.ts')['jobs']
let clips: typeof import('./db/index.ts')['clips']
let ownedJob: typeof import('./ownership.ts')['ownedJob']
let ownedClips: typeof import('./ownership.ts')['ownedClips']
let countActiveJobs: typeof import('./ownership.ts')['countActiveJobs']
let countJobsSince: typeof import('./ownership.ts')['countJobsSince']
let activeJob: typeof import('./ownership.ts')['activeJob']
let quotaUsage: typeof import('./ownership.ts')['quotaUsage']

let alice = ''
let bob = ''
let videoId = ''
let aliceJob = ''
let bobJob = ''
let aliceClip = ''
let bobClip = ''

beforeAll(async () => {
  if (!ENABLED) return

  const dbMod = await import('./db/index.ts')
  ;({ db, users, videos, jobs, clips } = dbMod)
  ;({ ownedJob, ownedClips, countActiveJobs, countJobsSince, activeJob, quotaUsage } = await import(
    './ownership.ts',
  ))

  const stamp = Date.now()
  const [a] = await db
    .insert(users)
    .values({ googleSub: `test-alice-${stamp}`, email: 'alice@test.invalid' })
    .returning()
  const [b] = await db
    .insert(users)
    .values({ googleSub: `test-bob-${stamp}`, email: 'bob@test.invalid' })
    .returning()
  alice = a.id
  bob = b.id

  const [v] = await db
    .insert(videos)
    .values({
      url: `https://test.invalid/ownership-${stamp}`,
      platform: 'test',
      title: 'Ownership fixture',
      durationSeconds: 600,
    })
    .returning()
  videoId = v.id

  const jobValues = {
    videoId,
    clipCount: 3,
    lengthPreset: 1,
    formats: { '9:16': true },
    burnSubtitles: true,
  }
  const [aj] = await db.insert(jobs).values({ ...jobValues, userId: alice }).returning()
  const [bj] = await db.insert(jobs).values({ ...jobValues, userId: bob }).returning()
  aliceJob = aj.id
  bobJob = bj.id

  const clipValues = {
    idx: 0,
    title: 'Fixture clip',
    startSeconds: 0,
    endSeconds: 30,
    score: 50,
    snippet: 's',
    caption: 'c',
    subtitleLine: 'l',
  }
  const [ac] = await db.insert(clips).values({ ...clipValues, jobId: aliceJob }).returning()
  const [bc] = await db.insert(clips).values({ ...clipValues, jobId: bobJob }).returning()
  aliceClip = ac.id
  bobClip = bc.id
})

afterAll(async () => {
  if (!ENABLED) return
  // Users cascade to jobs, which cascade to clips.
  await db.delete(users).where(inArray(users.id, [alice, bob]))
  await db.delete(videos).where(eq(videos.id, videoId))
})

maybe('an owner reaches their own job', async () => {
  const job = await ownedJob(alice, aliceJob)
  expect(job?.id).toBe(aliceJob)
})

maybe("a stranger cannot reach someone else's job", async () => {
  expect(await ownedJob(bob, aliceJob)).toBeNull()
})

maybe('a job that does not exist is indistinguishable from one you do not own', async () => {
  expect(await ownedJob(alice, '00000000-0000-0000-0000-000000000000')).toBeNull()
})

maybe('ownedClips returns only the caller\'s clips from a mixed list', async () => {
  const rows = await ownedClips(alice, [aliceClip, bobClip])
  expect(rows.map((r) => r.id)).toEqual([aliceClip])
})

maybe('ownedClips on someone else\'s clip alone returns nothing', async () => {
  expect(await ownedClips(alice, [bobClip])).toEqual([])
})

maybe('ownedClips tolerates an empty list without querying', async () => {
  expect(await ownedClips(alice, [])).toEqual([])
})

maybe('the active-job count is per user, not global', async () => {
  // Both fixtures are 'pending', which is an active status.
  expect(await countActiveJobs(alice)).toBe(1)
  expect(await countActiveJobs(bob)).toBe(1)
})

maybe('a completed job is not active', async () => {
  await db.update(jobs).set({ status: 'completed' }).where(eq(jobs.id, aliceJob))
  expect(await countActiveJobs(alice)).toBe(0)
  await db.update(jobs).set({ status: 'pending' }).where(eq(jobs.id, aliceJob))
})

maybe('the monthly count is per user and respects the window', async () => {
  const hourAgo = new Date(Date.now() - 3_600_000)
  expect(await countJobsSince(alice, hourAgo)).toBe(1)

  const future = new Date(Date.now() + 3_600_000)
  expect(await countJobsSince(alice, future)).toBe(0)
})

maybe('the in-flight job is reachable without knowing its id', async () => {
  // Both fixtures start 'pending', which is active.
  const found = await activeJob(alice)
  expect(found?.id).toBe(aliceJob)
})

maybe("one user's active job never appears as another's", async () => {
  const found = await activeJob(bob)
  expect(found?.id).toBe(bobJob)
  expect(found?.id).not.toBe(aliceJob)
})

maybe('a finished job is not "in progress"', async () => {
  await db.update(jobs).set({ status: 'completed' }).where(eq(jobs.id, aliceJob))
  expect(await activeJob(alice)).toBeNull()
  await db.update(jobs).set({ status: 'pending' }).where(eq(jobs.id, aliceJob))
})

maybe('a cancelled job is not "in progress" either', async () => {
  await db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, aliceJob))
  expect(await activeJob(alice)).toBeNull()
  await db.update(jobs).set({ status: 'pending' }).where(eq(jobs.id, aliceJob))
})

maybe('every mid-pipeline status counts as in progress', async () => {
  for (const status of ['downloading', 'transcribing', 'analyzing', 'rendering'] as const) {
    await db.update(jobs).set({ status }).where(eq(jobs.id, aliceJob))
    expect((await activeJob(alice))?.id).toBe(aliceJob)
  }
  await db.update(jobs).set({ status: 'pending' }).where(eq(jobs.id, aliceJob))
})

const DAY_AGO = () => new Date(Date.now() - 86_400_000)

maybe('quota usage counts the jobs this user created in the window', async () => {
  expect((await quotaUsage(alice, DAY_AGO())).used).toBe(1)
})

maybe('quota usage is per user, never the whole box', async () => {
  expect((await quotaUsage(bob, DAY_AGO())).used).toBe(1)
})

maybe('it reports the oldest job, so the UI can say when a slot frees', async () => {
  expect((await quotaUsage(alice, DAY_AGO())).oldestAt).toBeInstanceOf(Date)
})

maybe('an empty window means nothing used and no reset time', async () => {
  const usage = await quotaUsage(alice, new Date(Date.now() + 86_400_000))
  expect(usage.used).toBe(0)
  expect(usage.oldestAt).toBeNull()
})

maybe('a cancelled job still counts against the monthly allowance', async () => {
  // Deliberate: by the time you cancel, the download has usually already spent
  // the bandwidth and disk, so returning the slot would make the cap trivial to
  // sidestep by starting and cancelling repeatedly.
  await db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, aliceJob))
  expect((await quotaUsage(alice, DAY_AGO())).used).toBe(1)
  await db.update(jobs).set({ status: 'pending' }).where(eq(jobs.id, aliceJob))
})
