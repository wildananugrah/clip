/**
 * The editor's server-side off switch.
 *
 * Hiding the Edit chip stops the button, not the feature. These four routes are
 * ordinary HTTP, and a bookmark, a stale tab or a curl reaches them regardless
 * of what the UI renders -- so this is the half that makes "nobody can access
 * it" true rather than "nobody can see it".
 *
 * The assertion leans on a distinction the existing route tests already use:
 * a gated route answers the GATE's body (`Not found`), while an ungated one
 * reaches its handler and answers the HANDLER's body (`Job not found`, `Clip
 * not found`). So this checks the gate ran FIRST, not merely that something
 * 404'd -- which every unowned id would do anyway.
 *
 * Only the disabled state is covered here, because that is the state being
 * shipped. The enabled path is the behaviour these routes already had, and is
 * covered by the tests that existed before the flag.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { Hono } from 'hono'

// Before any import that reaches env.ts, which parses process.env once.
// 'false' is also the default, so this pins the intent rather than changing it.
process.env.EDITOR_ENABLED = 'false'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

let app: Hono

const UNKNOWN = '00000000-0000-0000-0000-0000000000ff'

beforeAll(async () => {
  const { jobsRoutes } = await import('./routes/jobs.ts')
  const { clipsRoutes } = await import('./routes/clips.ts')

  // Stands in for requireSession, as projects.route.test.ts does: a fixed user
  // owning nothing, so any handler that runs falls through to its own 404.
  app = new Hono()
  app.use('*', async (c, next) => {
    c.set('user', {
      id: '00000000-0000-0000-0000-0000000000aa',
      email: 'gate@test.invalid',
      name: null,
      pictureUrl: null,
      monthlyJobLimit: null,
      storageLimitBytes: null,
    })
    await next()
  })
  app.route('/api/jobs', jobsRoutes)
  app.route('/api/clips', clipsRoutes)
})

/**
 * No database needed for any of these: the gate answers before the handler
 * runs, which is the whole property under test.
 */
describe('editor routes are gated off', () => {
  test('POST /jobs/:id/assets is unreachable', async () => {
    const res = await app.request(`/api/jobs/${UNKNOWN}/assets`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('POST /jobs/:id/source is unreachable', async () => {
    const res = await app.request(`/api/jobs/${UNKNOWN}/source`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('GET /clips/:id/transcript is unreachable', async () => {
    const res = await app.request(`/api/clips/${UNKNOWN}/transcript`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('POST /clips/:id/copy is unreachable -- no saving a trim', async () => {
    const res = await app.request(`/api/clips/${UNKNOWN}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s: 1, e: 2 }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})

describe('what the gate must NOT catch', () => {
  /**
   * Redo is a results-screen button, not an editor one. Gating it would take
   * away a feature nobody asked to switch off -- the mistake this test exists
   * to catch if someone widens the gate later.
   *
   * Needs the database, because proving it is ungated means reaching the
   * handler and seeing ITS answer.
   */
  maybe('POST /clips/:id/redo still reaches its handler', async () => {
    const res = await app.request(`/api/clips/${UNKNOWN}/redo`, { method: 'POST' })
    expect(await res.json()).toEqual({ error: 'Clip not found' })
  })
})
