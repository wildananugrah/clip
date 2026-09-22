/**
 * The lease bookkeeping, against a real Postgres.
 *
 * Opt-in, because it needs the database:
 *
 *   RUN_DB_TESTS=1 bun --env-file=../.env test sourceCache.integration
 *
 * Against a real database rather than a mock on purpose: the thing under test
 * IS the SQL. `refs = refs + 1` is atomic and a read-modify-write is not, and
 * the four boss.work registrations poll independently, so two operations
 * really can hold one source at once. A mocked query would assert nothing
 * about the only property that matters.
 *
 * The eviction RULES are tested purely in shared/sourceCache.test.ts. What is
 * checked here is everything that touches the world: counting, the missing-file
 * path, host scoping, and boot recovery.
 *
 * One case shells out to yt-dlp (see its own comment), so this also wants
 * yt-dlp on PATH. It downloads nothing -- the URL is deliberately unresolvable.
 */
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { eq, and } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

let tmp = ''
let videoId = ''
let otherVideoId = ''

// Imported lazily: these modules validate env at import time, which would abort
// the whole file when the suite runs without a configured .env.
let db: typeof import('./db.ts')['db']
let schema: typeof import('./db.ts')
let env: typeof import('./env.ts')['env']
let sweepSources: typeof import('./retention.ts')['sweepSources']
let reclaimSourceLeases: typeof import('./sourceCache.ts')['reclaimSourceLeases']

/** A cache row for a file that really exists, so fileExists() is satisfied. */
async function seed(
  vid: string,
  over: Partial<{ hostId: string; refs: number; usedAt: Date; bytes: number }> = {},
) {
  const dir = join(tmp, vid)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'source.mp4')
  await writeFile(path, 'x')

  await db
    .insert(schema.videoSourceCache)
    .values({
      videoId: vid,
      hostId: over.hostId ?? env.WORKER_HOST_ID,
      path,
      bytes: over.bytes ?? 1024,
      usedAt: over.usedAt ?? new Date(),
      refs: over.refs ?? 0,
    })
    .onConflictDoUpdate({
      target: [schema.videoSourceCache.videoId, schema.videoSourceCache.hostId],
      set: { path, bytes: over.bytes ?? 1024, usedAt: over.usedAt ?? new Date(), refs: over.refs ?? 0 },
    })
  return path
}

const rowFor = async (vid: string, hostId?: string) =>
  (
    await db
      .select()
      .from(schema.videoSourceCache)
      .where(
        and(
          eq(schema.videoSourceCache.videoId, vid),
          eq(schema.videoSourceCache.hostId, hostId ?? env.WORKER_HOST_ID),
        ),
      )
  )[0]

beforeAll(async () => {
  if (!ENABLED) return

  const dbMod = await import('./db.ts')
  db = dbMod.db
  schema = dbMod
  env = (await import('./env.ts')).env
  sweepSources = (await import('./retention.ts')).sweepSources
  reclaimSourceLeases = (await import('./sourceCache.ts')).reclaimSourceLeases

  tmp = await mkdtemp(join(tmpdir(), 'clip-sources-'))

  const rows = await db
    .insert(schema.videos)
    .values([
      { url: `test://cache-${Date.now()}`, platform: 'Test', title: 'cache a', durationSeconds: 10 },
      { url: `test://cache-b-${Date.now()}`, platform: 'Test', title: 'cache b', durationSeconds: 10 },
    ])
    .returning()
  videoId = rows[0]!.id
  otherVideoId = rows[1]!.id
})

afterAll(async () => {
  if (!ENABLED) return
  // The cache rows cascade with the videos they hang off.
  for (const id of [videoId, otherVideoId]) {
    await db.delete(schema.videos).where(eq(schema.videos.id, id)).catch(() => {})
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  if (!ENABLED) return
  for (const id of [videoId, otherVideoId]) {
    await db.delete(schema.videoSourceCache).where(eq(schema.videoSourceCache.videoId, id))
  }
})

maybe('a second acquire on a cached source counts, and does not re-download', async () => {
  const path = await seed(videoId)
  const { acquireSource } = await import('./sourceCache.ts')
  const video = (await db.select().from(schema.videos).where(eq(schema.videos.id, videoId)))[0]!

  const first = await acquireSource(null, video, { quiet: true })
  const second = await acquireSource(null, video, { quiet: true })

  // Same file both times: nothing was fetched. This is the whole feature.
  expect(first.path).toBe(path)
  expect(second.path).toBe(path)
  expect((await rowFor(videoId))!.refs).toBe(2)

  // Releasing one leaves the other holding it, so the sweep must still spare it.
  await first.release()
  expect((await rowFor(videoId))!.refs).toBe(1)

  await second.release()
  expect((await rowFor(videoId))!.refs).toBe(0)
})

maybe('releasing twice cannot drive the count negative', async () => {
  await seed(videoId, { refs: 1 })
  const { acquireSource } = await import('./sourceCache.ts')
  const video = (await db.select().from(schema.videos).where(eq(schema.videos.id, videoId)))[0]!

  const lease = await acquireSource(null, video, { quiet: true })
  await lease.release()
  await lease.release()

  // A negative count would read as "in use" forever and make the file immortal.
  expect((await rowFor(videoId))!.refs).toBeGreaterThanOrEqual(0)
})

maybe('a row whose file has vanished is dropped rather than handed out', async () => {
  // A path that was never written: the volume was wiped, or somebody cleared
  // the disk by hand. Handing this back would fail a render on a missing file.
  await db.insert(schema.videoSourceCache).values({
    videoId,
    hostId: env.WORKER_HOST_ID,
    path: join(tmp, 'gone', 'source.mp4'),
    bytes: 1024,
    usedAt: new Date(),
    refs: 0,
  })

  const { acquireSource } = await import('./sourceCache.ts')
  const video = (await db.select().from(schema.videos).where(eq(schema.videos.id, videoId)))[0]!

  // It falls through to a real download, which fails on a test:// URL. What
  // matters is that the stale row was dropped on the way past rather than
  // returned, so the next attempt starts clean.
  //
  // The generous timeout is that shell-out: yt-dlp takes ~3s to decide it has
  // no extractor for this, which is well past bun's 5s default once the
  // pre-download sweep and the freshness check are in front of it.
  await acquireSource(null, video, { quiet: true }).catch(() => {})
  expect(await rowFor(videoId)).toBeUndefined()
}, 60_000)

maybe('a quiet acquire never touches the job status, even when it downloads', async () => {
  /**
   * The regression. A re-cut, a backfill and a source build all run against a
   * job that has already finished, and `quiet` is what keeps them from
   * announcing 'downloading' and dragging it back out of a terminal state.
   *
   * An earlier cut of downloadAndClaim gated that setStatus on `jobId` alone.
   * Running the worker for one minute was enough: the first backfill to drain
   * flipped a cancelled job to 'downloading'.
   *
   * No cache row exists here, so this takes the download path -- which is the
   * only path that ever called setStatus. It fails on a test:// URL, and that
   * is fine: the assertion is about what did NOT happen on the way past.
   */
  const [user] = await db
    .insert(schema.users)
    .values({ googleSub: `test-quiet-${Date.now()}`, email: 'quiet@test.invalid' })
    .returning()

  const [job] = await db
    .insert(schema.jobs)
    .values({
      userId: user!.id,
      videoId,
      status: 'completed',
      clipCount: 1,
      lengthPreset: 0,
      formats: { '9:16': true },
      burnSubtitles: false,
    })
    .returning()

  const { acquireSource } = await import('./sourceCache.ts')
  const video = (await db.select().from(schema.videos).where(eq(schema.videos.id, videoId)))[0]!

  await acquireSource(job!.id, video, { quiet: true }).catch(() => {})

  const [after] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, job!.id))
  expect(after!.status).toBe('completed')

  await db.delete(schema.users).where(eq(schema.users.id, user!.id))
}, 60_000)

maybe('the sweep spares a held source and takes an idle expired one', async () => {
  const longAgo = new Date(Date.now() - (env.SOURCE_TTL_MINUTES + 10) * 60_000)
  await seed(videoId, { refs: 1, usedAt: longAgo })
  await seed(otherVideoId, { refs: 0, usedAt: longAgo })

  await sweepSources()

  // Held beats stale, at any age. Idle and expired goes.
  expect(await rowFor(videoId)).toBeDefined()
  expect(await rowFor(otherVideoId)).toBeUndefined()
})

maybe('the sweep ignores another host\'s rows', async () => {
  const longAgo = new Date(Date.now() - (env.SOURCE_TTL_MINUTES + 10) * 60_000)
  await seed(videoId, { hostId: 'some-other-box', refs: 0, usedAt: longAgo })

  await sweepSources()

  // Expired and idle, but it is not ours: its path is on a disk we cannot see,
  // and deleting by it would either miss or hit an unrelated file.
  expect(await rowFor(videoId, 'some-other-box')).toBeDefined()
})

maybe('boot reclaims this host\'s leaked leases and leaves others alone', async () => {
  await seed(videoId, { refs: 3 })
  await seed(otherVideoId, { hostId: 'some-other-box', refs: 2 })

  await reclaimSourceLeases()

  // Asserted per row, not as a global count: this runs against a shared dev
  // database where a real worker may have left leases of its own, and a count
  // over rows the test does not own is a flake waiting to happen.
  expect((await rowFor(videoId))!.refs).toBe(0)
  // Another machine's lease is live work, not debris.
  expect((await rowFor(otherVideoId, 'some-other-box'))!.refs).toBe(2)
})
