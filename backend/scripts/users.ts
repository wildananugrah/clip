/**
 * List and manage accounts, from the box.
 *
 *   bun run users                          every account, newest first
 *   bun run users <email>                  one account in detail
 *   bun run users <email> --signout        revoke every session (log out everywhere)
 *   bun run users <email> --delete --yes   erase the account, its clips and their files
 *
 * There is no admin UI and the "Delete account" row in Settings is still a
 * stub, so this is the only way to remove somebody who asks -- which is a thing
 * they are entitled to ask for.
 *
 * Quotas live in the sibling scripts: `bun run quota <email>` and
 * `bun run projects <email>`.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { users, sessions, jobs, clips, renders } from '../../shared/schema.ts'
import { fmtBytes } from '../../shared/format.ts'

export interface UsersArgs {
  /** Undefined lists everyone; a value acts on that one account. */
  email: string | undefined
  signOut: boolean
  remove: boolean
  /** --yes. Without it, --delete only says what it would do. */
  confirmed: boolean
}

export function parseArgs(argv: string[]): UsersArgs {
  let email: string | undefined
  let signOut = false
  let remove = false
  let confirmed = false

  for (const arg of argv) {
    if (arg === '--signout') signOut = true
    else if (arg === '--delete') remove = true
    else if (arg === '--yes') confirmed = true
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`)
    else if (email === undefined) email = arg
    else throw new Error(`Unexpected argument "${arg}" -- this script acts on one account`)
  }

  // A missing email means "list everyone". Letting that combine with an action
  // would turn a typo into an action against every account on the box.
  if (email === undefined && (signOut || remove)) {
    throw new Error('--signout and --delete need an email. They never apply to everyone.')
  }

  return { email, signOut, remove, confirmed }
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')
  const { storage } = await import('../src/s3.ts')

  /** Rendered bytes and job counts per user, in one pass rather than per row. */
  const totals = await db
    .select({
      userId: jobs.userId,
      jobs: sql<number>`count(distinct ${jobs.id})`,
      bytes: sql<number>`coalesce(sum(${renders.sizeBytes}), 0)`,
    })
    .from(jobs)
    .leftJoin(clips, eq(clips.jobId, jobs.id))
    .leftJoin(renders, eq(renders.clipId, clips.id))
    .where(isNull(jobs.deletedAt))
    .groupBy(jobs.userId)
  const byUser = new Map(totals.map((t) => [t.userId, t]))

  if (args.email === undefined) {
    const rows = await db.select().from(users).orderBy(desc(users.createdAt))
    console.log(`${rows.length} account(s)\n`)
    for (const u of rows) {
      const t = byUser.get(u.id)
      console.log(`${u.email}${u.name ? `  (${u.name})` : ''}`)
      console.log(
        `  ${Number(t?.jobs ?? 0)} project(s), ${fmtBytes(Number(t?.bytes ?? 0))}` +
          `  ·  last seen ${u.lastSeenAt.toISOString()}`,
      )
    }
    return
  }

  const [user] = await db.select().from(users).where(eq(users.email, args.email)).limit(1)
  if (!user) {
    console.error(`No user with email ${args.email}`)
    process.exit(1)
  }

  if (args.signOut) {
    const gone = await db
      .delete(sessions)
      .where(eq(sessions.userId, user.id))
      .returning({ id: sessions.id })
    console.log(`Revoked ${gone.length} session(s). They will be signed out on the next request.`)
  }

  if (args.remove) {
    const owned = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.userId, user.id))
    const ids = owned.map((j) => j.id)

    // The S3 objects have to go BEFORE the rows: deleting the user cascades the
    // jobs, clips and renders away, and with them the only record of which keys
    // belonged to it. Rows first would leave the files orphaned forever.
    const clipRows = ids.length
      ? await db.select({ id: clips.id }).from(clips).where(inArray(clips.jobId, ids))
      : []
    const renderRows = clipRows.length
      ? await db
          .select({
            s3Key: renders.s3Key,
            thumbKey: renders.thumbKey,
            storage: renders.storage,
          })
          .from(renders)
          .where(
            inArray(
              renders.clipId,
              clipRows.map((c) => c.id),
            ),
          )
      : []
    // Each row names its own backend: an account can hold clips written before
    // and after the write target moved, and a flat key list would aim half of
    // them at the wrong bucket -- deleting nothing while reporting success.
    const objects = renderRows.flatMap((r) =>
      [r.s3Key, r.thumbKey]
        .filter(Boolean)
        .map((key) => ({ storage: r.storage, key: key as string })),
    )

    if (!args.confirmed) {
      console.log(
        `Would delete ${user.email}: ${ids.length} project(s), ${clipRows.length} clip(s), ` +
          `${objects.length} file(s). This cannot be undone.\n` +
          'Re-run with --yes to do it.',
      )
      return
    }

    // deleteMany reports per backend and carries on: the rows are about to go,
    // so anything left behind is an orphan nobody can find from the database
    // again -- but one unreachable backend must not abort the whole delete.
    if (objects.length) await storage.deleteMany(objects)
    // One delete: sessions, jobs, clips and renders all cascade from the user.
    await db.delete(users).where(eq(users.id, user.id))
    console.log(`Deleted ${user.email}: ${ids.length} project(s), ${objects.length} file(s).`)
    return
  }

  const t = byUser.get(user.id)
  const live = await db
    .select({ expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.userId, user.id)))

  console.log(`\n${user.email} (${user.id})`)
  console.log(`  name         ${user.name ?? '—'}`)
  console.log(`  joined       ${user.createdAt.toISOString()}`)
  console.log(`  last seen    ${user.lastSeenAt.toISOString()}`)
  console.log(`  projects     ${Number(t?.jobs ?? 0)}`)
  console.log(`  storage      ${fmtBytes(Number(t?.bytes ?? 0))}`)
  console.log(`  sessions     ${live.length} live`)
  console.log(`  quotas       bun run quota ${user.email}`)
  console.log(`               bun run projects ${user.email}`)
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
