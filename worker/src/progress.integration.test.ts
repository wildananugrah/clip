/**
 * A cancelled job stays cancelled, against a real Postgres.
 *
 * Opt-in, because it needs the database:
 *
 *   RUN_DB_TESTS=1 bun --env-file=../.env test progress.integration
 *
 * NEVER point this at production. It creates and deletes a user.
 *
 * Against a real database because the thing under test IS the WHERE clause.
 * The bug it pins: the cancel route flipped the row, then a progress write from
 * inside a stage put it back to `downloading`. The job then counted as running
 * forever, refusing every new one, while the UI showed nothing to cancel.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

// Imported lazily: these modules validate env at import time.
let db: typeof import('./db.ts')['db']
let schema: typeof import('./db.ts')
let setStatus: typeof import('./progress.ts')['setStatus']

let userId = ''
let videoId = ''
let jobId = ''

beforeAll(async () => {
  if (!ENABLED) return
  ;({ db } = await import('./db.ts'))
  schema = await import('./db.ts')
  ;({ setStatus } = await import('./progress.ts'))

  const [user] = await db
    .insert(schema.users)
    .values({ email: `cancel-${Date.now()}@test.invalid`, googleSub: `cancel-${Date.now()}` })
    .returning()
  userId = user!.id
  const [video] = await db
    .insert(schema.videos)
    .values({ url: `test://cancel-${Date.now()}`, platform: 'Test', title: 't', durationSeconds: 10 })
    .returning()
  videoId = video!.id
  const [job] = await db
    .insert(schema.jobs)
    .values({ userId, videoId, clipCount: 1, lengthPreset: 0, formats: { '9:16': true } })
    .returning()
  jobId = job!.id
})

afterAll(async () => {
  if (!ENABLED) return
  // Jobs cascade with the user; the video is global and goes separately.
  await db.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => {})
  await db.delete(schema.videos).where(eq(schema.videos.id, videoId)).catch(() => {})
})

const status = async () =>
  (await db.select({ s: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, jobId)))[0]!.s

maybe('a progress write cannot un-cancel a job', async () => {
  await setStatus(jobId, { status: 'downloading', stage: 'Starting', progress: 0 })
  // What POST /jobs/:id/cancel does.
  await db.update(schema.jobs).set({ status: 'cancelled' }).where(eq(schema.jobs.id, jobId))

  // acquireSource, mid-stage, not yet at a boundary where it would notice.
  await setStatus(jobId, { status: 'downloading', stage: 'Downloading source', progress: 0 })
  expect(await status()).toBe('cancelled')

  // Nor can the failure path, when the killed download throws something else.
  await setStatus(jobId, { status: 'failed', stage: 'Failed', error: 'yt-dlp exited 1' })
  expect(await status()).toBe('cancelled')
})

maybe('the pipeline can still write cancelled itself', async () => {
  await setStatus(jobId, { status: 'cancelled', stage: 'Cancelled' })
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId))
  expect(row!.status).toBe('cancelled')
  expect(row!.stage).toBe('Cancelled')
})

maybe('an uncancelled job still moves normally', async () => {
  await db.update(schema.jobs).set({ status: 'pending' }).where(eq(schema.jobs.id, jobId))
  await setStatus(jobId, { status: 'rendering', stage: 'Rendering 1 of 1', progress: 72 })
  expect(await status()).toBe('rendering')
})
