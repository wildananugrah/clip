/**
 * Session gate.
 *
 * Replaces the Tier A shared-secret middleware. That gate compared `API_TOKEN`
 * in constant time, which was sound cryptography protecting a secret the SPA
 * published: the bundle was built with VITE_API_TOKEN inlined, so every visitor
 * could read it. It was also why the SSE route accepted the token as a query
 * parameter -- EventSource cannot set headers -- which put the secret into nginx
 * access logs. Cookies are sent by EventSource natively, so both are gone.
 *
 * The lookup is injected rather than imported so this module stays free of the
 * database (and therefore of env.ts, which exits the process when unconfigured),
 * which is what lets the gate be tested without either.
 */
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { hashToken, isExpired } from './session.ts'

export const SESSION_COOKIE = 'clip_session'

/** The signed-in user, as handlers see it on the context. */
export interface SessionUser {
  id: string
  email: string
  name: string | null
  pictureUrl: string | null
  /** Per-user job allowance, or null to follow QUOTA_JOBS_PER_MONTH. */
  monthlyJobLimit: number | null
  /** Per-user rendered-bytes cap, or null to follow QUOTA_STORAGE_GB. */
  storageLimitBytes: number | null
}

/** Resolves a session id (the token's hash) to its user, or null. */
export type SessionLookup = (
  sessionId: string,
) => Promise<{ user: SessionUser; expiresAt: Date } | null>

declare module 'hono' {
  interface ContextVariableMap {
    user: SessionUser
  }
}

export function requireSession(lookup: SessionLookup): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? ''
    // No cookie cannot become a session, so do not spend a query on it.
    if (!token) return c.json({ error: 'Unauthorized' }, 401)

    const found = await lookup(hashToken(token))
    if (!found || isExpired(found.expiresAt)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('user', found.user)
    await next()
  }
}
