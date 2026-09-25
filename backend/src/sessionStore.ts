/**
 * Users and sessions in Postgres. The only module that turns Google's claims
 * into a row, and a cookie into a user.
 */
import { eq } from 'drizzle-orm'
import { db, users, sessions } from './db/index.ts'
import { newSessionToken, expiryFrom } from './session.ts'
import type { SessionUser } from './auth.ts'
import type { User } from '../../shared/schema.ts'

/** The subset of Google's id_token claims this app uses. */
export interface GoogleClaims {
  sub: string
  email: string
  name: string | null
  picture: string | null
}

/**
 * Upsert on `google_sub`, not email. An account's email can change, and keying
 * on it would either duplicate the user or hand their projects to whoever
 * inherits the old address.
 */
export async function upsertGoogleUser(claims: GoogleClaims): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      googleSub: claims.sub,
      email: claims.email,
      name: claims.name,
      pictureUrl: claims.picture,
    })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: {
        email: claims.email,
        name: claims.name,
        pictureUrl: claims.picture,
        lastSeenAt: new Date(),
      },
    })
    .returning()
  return user
}

export async function createSession(
  userId: string,
  ttlDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, id } = newSessionToken()
  const expiresAt = expiryFrom(ttlDays)
  await db.insert(sessions).values({ id, userId, expiresAt })
  return { token, expiresAt }
}

/**
 * Resolve a session id (the token's hash) to its user. Expiry is deliberately
 * NOT filtered here -- the middleware decides, so there is one definition of
 * "expired" rather than one in SQL and another in TypeScript.
 */
export async function lookupSession(
  sessionId: string,
): Promise<{ user: SessionUser; expiresAt: Date } | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      pictureUrl: users.pictureUrl,
      monthlyJobLimit: users.monthlyJobLimit,
      storageLimitBytes: users.storageLimitBytes,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1)

  if (!row) return null
  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      pictureUrl: row.pictureUrl,
      monthlyJobLimit: row.monthlyJobLimit,
      storageLimitBytes: row.storageLimitBytes,
    },
    expiresAt: row.expiresAt,
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}
