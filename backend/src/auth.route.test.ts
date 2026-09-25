/**
 * The gate, exercised through a real Hono app rather than by inspecting the
 * middleware. A request with no cookie must never reach a handler, and that is a
 * property of the mounted app, not of a function.
 *
 * The session lookup is injected, so these cases prove something stronger than
 * "401 was returned": they prove the database is never consulted for a request
 * that cannot possibly be authenticated.
 */
import { test, expect, describe } from 'bun:test'
import { Hono } from 'hono'
import { requireSession, type SessionLookup } from './auth.ts'

/** A lookup that records its calls and always denies. */
function denyingLookup() {
  const calls: string[] = []
  const lookup: SessionLookup = async (id) => {
    calls.push(id)
    return null
  }
  return { lookup, calls }
}

/** A minimal app shaped like index.ts: one public route, one gated. */
function makeApp(lookup: SessionLookup) {
  const app = new Hono()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', requireSession(lookup))
  app.get('/api/projects', (c) => c.json({ reached: true }))
  return app
}

describe('requireSession', () => {
  test('a request with no cookie is refused', async () => {
    const { lookup } = denyingLookup()
    const res = await makeApp(lookup).request('/api/projects')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('no cookie means no database query at all', async () => {
    const { lookup, calls } = denyingLookup()
    await makeApp(lookup).request('/api/projects')
    expect(calls).toEqual([])
  })

  test('a handler behind the gate never runs without a session', async () => {
    const { lookup } = denyingLookup()
    const res = await makeApp(lookup).request('/api/projects')
    expect(await res.text()).not.toContain('reached')
  })

  test('a cookie that looks real is looked up by its hash, not its raw value', async () => {
    const { lookup, calls } = denyingLookup()
    await makeApp(lookup).request('/api/projects', {
      headers: { Cookie: 'clip_session=abcdef' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toBe('abcdef')
    expect(calls[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  test('an unknown session is refused', async () => {
    const { lookup } = denyingLookup()
    const res = await makeApp(lookup).request('/api/projects', {
      headers: { Cookie: 'clip_session=abcdef' },
    })
    expect(res.status).toBe(401)
  })

  test('an empty cookie value is refused without a query', async () => {
    const { lookup, calls } = denyingLookup()
    const res = await makeApp(lookup).request('/api/projects', {
      headers: { Cookie: 'clip_session=' },
    })
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  test('an expired session is refused even though the row exists', async () => {
    const expired: SessionLookup = async () => ({
      user: { id: 'u1', email: 'a@test.invalid', name: null, pictureUrl: null, monthlyJobLimit: null, storageLimitBytes: null },
      expiresAt: new Date(Date.now() - 1000),
    })
    const res = await makeApp(expired).request('/api/projects', {
      headers: { Cookie: 'clip_session=abcdef' },
    })
    expect(res.status).toBe(401)
  })

  test('a live session reaches the handler', async () => {
    const live: SessionLookup = async () => ({
      user: { id: 'u1', email: 'a@test.invalid', name: null, pictureUrl: null, monthlyJobLimit: null, storageLimitBytes: null },
      expiresAt: new Date(Date.now() + 60_000),
    })
    const res = await makeApp(live).request('/api/projects', {
      headers: { Cookie: 'clip_session=abcdef' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reached: true })
  })

  test('the handler can read the signed-in user off the context', async () => {
    const live: SessionLookup = async () => ({
      user: { id: 'u42', email: 'who@test.invalid', name: 'Who', pictureUrl: null, monthlyJobLimit: null, storageLimitBytes: null },
      expiresAt: new Date(Date.now() + 60_000),
    })
    const app = new Hono()
    app.use('/api/*', requireSession(live))
    app.get('/api/whoami', (c) => c.json({ id: c.get('user').id, email: c.get('user').email }))
    const res = await app.request('/api/whoami', { headers: { Cookie: 'clip_session=abcdef' } })
    expect(await res.json()).toEqual({ id: 'u42', email: 'who@test.invalid' })
  })

  test('the health check stays public -- a probe that needs a session is useless', async () => {
    const { lookup } = denyingLookup()
    const res = await makeApp(lookup).request('/api/health')
    expect(res.status).toBe(200)
  })

  test('a bearer token is no longer accepted: the bundled secret was never secret', async () => {
    const { lookup } = denyingLookup()
    const res = await makeApp(lookup).request('/api/projects', {
      headers: { Authorization: 'Bearer anything-at-all' },
    })
    expect(res.status).toBe(401)
  })

  test('the ?token= query parameter is no longer accepted on SSE either', async () => {
    const { lookup } = denyingLookup()
    const app = makeApp(lookup)
    app.get('/api/jobs/:id/events', (c) => c.json({ reached: true }))
    const res = await app.request('/api/jobs/abc/events?token=anything-at-all')
    expect(res.status).toBe(401)
  })
})
