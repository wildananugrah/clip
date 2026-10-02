/**
 * The recommendation panel's off switch, on the server side.
 *
 * Same argument as editorGate.ts: hiding the panel stops the button, not the
 * feature. The routes behind it are ordinary HTTP and a bookmark, an old tab or
 * a curl reaches them just the same. This is the half that makes "nobody can
 * use it" true rather than merely "nobody can see it", and it matters more here
 * than for the editor -- POST /recommendations spends money on every call.
 *
 * It also gates the per-clip caption suggestions (routes/social.ts), which spend
 * on the same model bill and so want the same lever.
 *
 * 404, NOT 403, for the reason editorGate gives: while the feature is off these
 * endpoints do not exist as far as the outside world is concerned, and 403
 * would advertise something deliberately unavailable and invite retrying.
 */
import type { MiddlewareHandler } from 'hono'
import { env } from './env.ts'

export const recommendationsGate: MiddlewareHandler = async (c, next) => {
  if (!env.RECOMMENDATIONS_ENABLED) return c.json({ error: 'Not found' }, 404)
  await next()
}
