import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env, corsOrigins } from './env.ts'
import { requireSession } from './auth.ts'
import { lookupSession } from './sessionStore.ts'
import { authRoutes, authSessionRoutes } from './routes/auth.ts'
import { startQueue } from './queue.ts'
import { reconcileJobs } from './reconcile.ts'
import { ensureListening } from './events.ts'
import { warnAboutStorage } from './s3.ts'
import { sources } from './routes/sources.ts'
import { jobsRoutes } from './routes/jobs.ts'
import { recommendationRoutes } from './routes/recommendations.ts'
import { socialRoutes } from './routes/social.ts'
import { clipsRoutes, downloadsRoutes } from './routes/clips.ts'
import { mediaRoutes } from './routes/media.ts'
import { pool } from './db/index.ts'

const app = new Hono()

app.use('*', logger())
/**
 * Vestigial since Tier C: the SPA and API share an origin in production, and in
 * development Vite proxies /api so they share one there too (a SameSite=Lax
 * session cookie is not sent on a cross-origin fetch). Kept, with credentials
 * enabled, so a non-proxied origin in CORS_ORIGIN still works if one is added.
 */
app.use(
  '/api/*',
  cors({
    origin: corsOrigins,
    credentials: true,
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }),
)

/** Unauthenticated: a health check that needs a secret is useless to a probe. */
app.get('/api/health', async (c) => {
  try {
    await pool.query('select 1')
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 503)
  }
})

/**
 * Sign-in, mounted BEFORE the gate: you cannot present a session while getting
 * one. Only /google and /google/callback live here; /me and /logout are below.
 */
app.route('/api/auth', authRoutes)

/**
 * Media is mounted BEFORE the session middleware, but is not public: it checks
 * the cookie itself (routes/media.ts) so that a signed-out <img> gets a 404
 * rather than a JSON 401 the browser would render as a broken image.
 */
app.route('/api/media', mediaRoutes)

app.use('/api/*', requireSession(lookupSession))

app.route('/api/auth', authSessionRoutes)
app.route('/api/sources', sources)
app.route('/api/jobs', jobsRoutes)
app.route('/api/jobs', recommendationRoutes)
app.route('/api/projects', jobsRoutes) // GET / lists completed jobs
app.route('/api/clips', clipsRoutes)
app.route('/api/clips', socialRoutes)
app.route('/api/downloads', downloadsRoutes)

/**
 * Turn thrown errors into JSON. Messages from this codebase are written for the
 * user ("That video is too short to clip"), so they are surfaced; anything else
 * is logged and replaced, to avoid leaking stack traces or ffmpeg dumps.
 */
app.onError((err, c) => {
  console.error('[api]', err)
  const safe = err instanceof Error && err.message.length < 300 ? err.message : 'Something broke.'
  return c.json({ error: safe }, 500)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

await startQueue()
await ensureListening()

/**
 * Repair jobs whose status outlived the work it described, before serving a
 * single request -- every write path refuses a job that is not 'completed', so
 * a polluted row is a project nobody can save, edit or re-cut.
 */
{
  const repaired = await reconcileJobs().catch((e: Error) => {
    // Never fatal: a reconcile that cannot run leaves things exactly as they
    // were, which is worth less than the API being up.
    console.error('[api] job reconcile failed:', e.message)
    return null
  })
  if (repaired?.completed) {
    console.log(`[api] reconciled jobs: ${repaired.completed} restored to completed`)
  }
}
// Warn, never exit: the API only reads, so a backend it cannot reach costs
// those clips and nothing else. The worker is stricter about the write target.
await warnAboutStorage()

console.log(`api listening on http://${env.HOST}:${env.PORT}`)

export default {
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
  // A 40-minute SSE stream must not be reaped by Bun's request timeout.
  idleTimeout: 255,
}
