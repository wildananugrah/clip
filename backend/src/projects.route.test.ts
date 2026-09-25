/**
 * Route wiring for deleting a project.
 *
 * Everything under /api/* sits behind requireSession, so an unauthenticated
 * probe answers 401 whether or not the route exists -- which means a curl cannot
 * tell a registered DELETE from a missing one. This can: a matched handler
 * returns its own JSON body, an unmatched path returns Hono's plain 404.
 *
 * The router is mounted under both prefixes in index.ts, so both are checked.
 */
import { test, expect, describe, beforeAll } from 'bun:test'
import { Hono } from 'hono'

const ENABLED = process.env.RUN_DB_TESTS === '1'
const maybe = ENABLED ? test : test.skip

let app: Hono

beforeAll(async () => {
  if (!ENABLED) return
  const { jobsRoutes } = await import('./routes/jobs.ts')

  // Stands in for requireSession: a fixed user, no cookie handling. The user id
  // is a real uuid shape but owns nothing, so ownership lookups miss.
  app = new Hono()
  app.use('*', async (c, next) => {
    c.set('user', {
      id: '00000000-0000-0000-0000-0000000000aa',
      email: 'route@test.invalid',
      name: null,
      pictureUrl: null,
      monthlyJobLimit: null,
      storageLimitBytes: null,
    })
    await next()
  })
  app.route('/api/jobs', jobsRoutes)
  app.route('/api/projects', jobsRoutes)
})

const UNKNOWN = '00000000-0000-0000-0000-0000000000ff'

describe('DELETE project route', () => {
  maybe('is registered under /api/projects', async () => {
    const res = await app.request(`/api/projects/${UNKNOWN}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    // The handler's own body, not Hono's fallback -- so the route matched.
    expect(await res.json()).toEqual({ error: 'Job not found' })
  })

  maybe('is registered under /api/jobs too', async () => {
    const res = await app.request(`/api/jobs/${UNKNOWN}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Job not found' })
  })

  maybe('a path with no route still 404s without a JSON body', async () => {
    // Proves the assertion above actually distinguishes the two cases.
    const res = await app.request('/api/projects/x/y/z', { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('Job not found')
  })

  maybe('deleting is not exposed as a GET', async () => {
    // The list handler lives at GET /, so a stray GET on an id must not delete.
    const res = await app.request(`/api/projects/${UNKNOWN}`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})
