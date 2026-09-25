/**
 * The recommendation panel's server-side off switch.
 *
 * Same argument as editorGate.route.test.ts, and the same assertion trick: a
 * gated route answers the GATE's body (`Not found`), an ungated one reaches its
 * handler and answers the HANDLER's (`Job not found`). So this proves the gate
 * ran FIRST, not merely that something 404'd -- an unowned id would do that
 * anyway.
 *
 * It matters more here than for the editor. POST /recommendations spends money
 * on every call, so "the panel is hidden" is not an adequate defence: a stale
 * tab left open by a user whose access was meant to end can still bill you.
 *
 * The flag defaults to TRUE, unlike EDITOR_ENABLED, so this test has to set it
 * -- which is the point. It pins the off state, which is the one with no UI
 * anywhere to demonstrate it.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { Hono } from 'hono'

let app: Hono

const UNKNOWN = '00000000-0000-0000-0000-0000000000ff'

beforeAll(async () => {
  /**
   * Set on the PARSED env, not on process.env.
   *
   * editorGate.route.test.ts assigns process.env before its first import and
   * gets away with it because 'false' is also EDITOR_ENABLED's default -- so it
   * pins intent rather than changing anything. This flag defaults to true, so
   * that trick does not work: env.ts parses process.env exactly once, and in a
   * full-suite run some earlier file has already triggered it. The assignment
   * would land too late and the gate would stay open.
   *
   * The gate reads env per request, so setting it here is order-independent and
   * still exercises the real middleware on the real routes.
   */
  const { env } = await import('./env.ts')
  env.RECOMMENDATIONS_ENABLED = false

  const { recommendationRoutes } = await import('./routes/recommendations.ts')

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
  app.route('/api/jobs', recommendationRoutes)
})

/**
 * No database needed for any of these: the gate answers before the handler
 * runs, which is the whole property under test.
 */
describe('recommendation routes are gated off', () => {
  test('GET /jobs/:id/recommendations is unreachable', async () => {
    const res = await app.request(`/api/jobs/${UNKNOWN}/recommendations`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('POST /jobs/:id/recommendations spends nothing when off', async () => {
    const res = await app.request(`/api/jobs/${UNKNOWN}/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'more about funding' }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  test('POST /jobs/:id/clips is unreachable -- no creating from a stale list', async () => {
    const res = await app.request(`/api/jobs/${UNKNOWN}/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId: UNKNOWN, indices: [0] }),
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })
})
