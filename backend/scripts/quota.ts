/**
 * Read and adjust one user's clip allowance, from the box.
 *
 *   bun run quota <email>                   show what the server would decide
 *   bun run quota <email> --limit 20        give this user 20 jobs per month
 *   bun run quota <email> --limit default   put them back on QUOTA_JOBS_PER_MONTH
 *   bun run quota <email> --storage 20      give this user 20 GB of renders
 *   bun run quota <email> --storage default put them back on QUOTA_STORAGE_GB
 *   bun run quota <email> --release         cancel a job that is stuck running
 *
 * Three different things block a new job (see quota.ts): a job still running,
 * this calendar month's count (UTC), and the rendered bytes held. The status output
 * names which one is biting, because raising the monthly limit does nothing for a
 * user who is out of disk, and --release does nothing for one who is simply out
 * of slots.
 *
 * Nothing here rewrites jobs.created_at: the count is derived from it, so
 * backdating a row into last month would buy a slot by lying about history. The override column is the honest lever.
 */
import { and, eq, gte, inArray } from 'drizzle-orm'
import { users, jobs, jobStatus } from '../../shared/schema.ts'
import { isTerminal } from '../../shared/types.ts'
import { fmtBytes } from '../../shared/format.ts'
import { quotaVerdict, quotaWindow } from '../src/quota.ts'

const GB = 1024 ** 3

export interface QuotaArgs {
  email: string
  /** A number to set, null to clear the override, undefined to leave it alone. */
  limit: number | null | undefined
  /** Same three-way meaning as `limit`, but in bytes: the column's unit. */
  storageBytes: number | null | undefined
  release: boolean
}

export function parseArgs(argv: string[]): QuotaArgs {
  let email: string | undefined
  let limit: number | null | undefined
  let storageBytes: number | null | undefined
  let release = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--release') {
      release = true
    } else if (arg === '--limit') {
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
    } else if (arg === '--storage') {
      const raw = argv[++i]
      if (raw === undefined) throw new Error('--storage needs a number of GB, or "default"')
      if (raw === 'default') {
        storageBytes = null
      } else {
        // GB in, bytes out: the flag is for a person, the column is for Postgres.
        const gb = Number(raw)
        if (!Number.isFinite(gb) || gb < 0) {
          throw new Error(`--storage must be GB >= 0, or "default" (got "${raw}")`)
        }
        storageBytes = Math.round(gb * GB)
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
    throw new Error(
      'Usage: bun run quota <email> [--limit N|default] [--storage GB|default] [--release]',
    )
  }
  return { email, limit, storageBytes, release }
}

const ACTIVE = jobStatus.enumValues.filter((s) => !isTerminal(s))

async function main() {
  const args = parseArgs(Bun.argv.slice(2))
  // Imported here, not at the top: env.ts exits the process when the
  // environment is unset, which would make parseArgs untestable.
  const { db } = await import('../src/db/index.ts')
  const { env } = await import('../src/env.ts')

  const [user] = await db.select().from(users).where(eq(users.email, args.email)).limit(1)
  if (!user) {
    console.error(`No user with email ${args.email}`)
    process.exit(1)
  }

  if (args.release) {
    // Same write the cancel route makes. The worker checks status between
    // stages, so a job it is still holding stops at the next boundary.
    const freed = await db
      .update(jobs)
      .set({ status: 'cancelled', stage: 'Cancelled (admin)', completedAt: new Date() })
      .where(and(eq(jobs.userId, user.id), inArray(jobs.status, ACTIVE)))
      .returning({ id: jobs.id })
    console.log(`Released ${freed.length} stuck job(s).`)
    // ponytail: the pg-boss row is left alone; the worker's own status check
    // drops it. Delete it here too if abandoned queue rows start piling up.
  }

  if (args.limit !== undefined) {
    await db.update(users).set({ monthlyJobLimit: args.limit }).where(eq(users.id, user.id))
    console.log(
      args.limit === null
        ? `Monthly override cleared — back on the default of ${env.QUOTA_JOBS_PER_MONTH}/month.`
        : `Monthly limit for ${user.email} set to ${args.limit}.`,
    )
  }

  if (args.storageBytes !== undefined) {
    await db.update(users).set({ storageLimitBytes: args.storageBytes }).where(eq(users.id, user.id))
    console.log(
      args.storageBytes === null
        ? `Storage override cleared — back on the default of ${env.QUOTA_STORAGE_GB} GB.`
        : `Storage limit for ${user.email} set to ${fmtBytes(args.storageBytes)}.`,
    )
  }

  const { start: since, resetsAt } = quotaWindow()
  const recent = await db
    .select({ createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), gte(jobs.createdAt, since)))
    .orderBy(jobs.createdAt)
  const active = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), inArray(jobs.status, ACTIVE)))

  const { storageUsage } = await import('../src/ownership.ts')
  const held = await storageUsage(user.id)

  // What the column holds AFTER this run's writes, so the status lines describe
  // the state the server will actually see -- not the one we loaded on entry.
  const limitOverride = args.limit === undefined ? user.monthlyJobLimit : args.limit
  const storageOverride =
    args.storageBytes === undefined ? user.storageLimitBytes : args.storageBytes
  const effectiveLimit = limitOverride ?? env.QUOTA_JOBS_PER_MONTH
  const effectiveStorage = storageOverride ?? env.QUOTA_STORAGE_GB * GB
  const source = (o: number | null) => (o === null ? '(global default)' : '(per-user override)')
  const refusal = quotaVerdict({
    activeCount: active.length,
    monthlyCount: recent.length,
    monthlyLimit: effectiveLimit,
    storageBytes: held,
    storageLimitBytes: effectiveStorage,
  })

  console.log(`\n${user.email} (${user.id})`)
  console.log(`  limit        ${effectiveLimit}/month ${source(limitOverride)}`)
  console.log(`  used         ${recent.length} since ${since.toISOString().slice(0, 10)} (UTC)`)
  console.log(`  storage      ${fmtBytes(held)} of ${fmtBytes(effectiveStorage)} ${source(storageOverride)}`)
  console.log(`  running now  ${active.length}${active.length ? ` (${active.map((j) => j.status).join(', ')})` : ''}`)
  console.log(`  resets at    ${resetsAt.toISOString()}`)
  console.log(refusal ? `  BLOCKED — ${refusal.message}` : '  CAN START A NEW JOB')
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
