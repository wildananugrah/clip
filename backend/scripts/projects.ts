/**
 * Read and adjust how many projects one user can hold, from the box.
 *
 *   bun run projects <email>                   the count, the cap, and the projects held
 *   bun run projects <email> --limit 30        let this user hold 30 projects
 *   bun run projects <email> --limit default   put them back on QUOTA_PROJECTS
 *
 * The cap is on projects KEPT, not made: deleting one frees its slot at once,
 * whether the user does it from the Projects screen or you do it with
 * `bun run jobs delete <id> --yes` (the ids are listed below the status). That
 * is the difference from the monthly allowance in scripts/quota.ts, which only
 * comes back on the 1st.
 *
 * Counted with the same filter as the Projects screen (projectsOf in
 * ownership.ts), so the number printed here is the number the user sees and the
 * number POST /api/jobs checks.
 */
import { desc, eq, sql } from 'drizzle-orm'
import { users, jobs, videos } from '../../shared/schema.ts'

export interface ProjectsArgs {
  email: string
  /** A number to set, null to clear the override, undefined to leave it alone. */
  limit: number | null | undefined
}

export function parseArgs(argv: string[]): ProjectsArgs {
  let email: string | undefined
  let limit: number | null | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--limit') {
      const raw = argv[++i]
      if (raw === undefined) throw new Error('--limit needs a number, or "default"')
      if (raw === 'default') {
        limit = null
      } else {
        limit = Number(raw)
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error(`--limit must be a whole number >= 0, or "default" (got "${raw}")`)
        }
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}`)
    } else if (email === undefined) {
      email = arg
    } else {
      throw new Error(`Unexpected argument "${arg}"`)
    }
  }

  if (email === undefined) {
    throw new Error('Usage: bun run projects <email> [--limit N|default]')
  }
  return { email, limit }
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')
  const { env } = await import('../src/env.ts')
  const { projectsOf } = await import('../src/ownership.ts')

  const [user] = await db.select().from(users).where(eq(users.email, args.email)).limit(1)
  if (!user) {
    console.error(`No user with email ${args.email}`)
    process.exit(1)
  }

  if (args.limit !== undefined) {
    await db.update(users).set({ projectLimit: args.limit }).where(eq(users.id, user.id))
    console.log(
      args.limit === null
        ? `Project override cleared — back on the default of ${env.QUOTA_PROJECTS}.`
        : `Project limit for ${user.email} set to ${args.limit}.`,
    )
  }

  const held = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      clipCount: jobs.clipCount,
      title: videos.title,
      at: sql<Date>`coalesce(${jobs.completedAt}, ${jobs.createdAt})`.mapWith(jobs.createdAt),
    })
    .from(jobs)
    .innerJoin(videos, eq(jobs.videoId, videos.id))
    .where(projectsOf(user.id))
    .orderBy(desc(sql`coalesce(${jobs.completedAt}, ${jobs.createdAt})`))

  // What the column holds AFTER this run's write, so the status line describes
  // the state the server will actually see -- not the one we loaded on entry.
  const override = args.limit === undefined ? user.projectLimit : args.limit
  const limit = override ?? env.QUOTA_PROJECTS
  const source = override === null ? '(global default)' : '(per-user override)'

  console.log(`\n${user.email} (${user.id})`)
  console.log(`  limit        ${limit} projects ${source}`)
  console.log(`  held         ${held.length}`)
  console.log(
    held.length >= limit
      ? `  BLOCKED — at the project limit. Delete one, or raise it with --limit.`
      : `  ${limit - held.length} slot(s) free`,
  )

  if (held.length) {
    console.log('')
    for (const p of held) {
      const title = p.title.length > 60 ? `${p.title.slice(0, 59)}…` : p.title
      console.log(
        `  ${p.id.slice(0, 8)}  ${p.at.toISOString().slice(0, 10)}  ${p.status.padEnd(12)} ${String(p.clipCount).padStart(2)} clips  ${title}`,
      )
    }
    console.log(`\n  Free a slot: bun run jobs delete <id> --yes`)
  }
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
