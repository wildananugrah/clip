import { test, expect, describe } from 'bun:test'
import { quotaVerdict, quotaWindow } from './quota.ts'

describe('quotaVerdict', () => {
  const limit = 3

  test('a first job of the month is allowed', () => {
    expect(quotaVerdict({ activeCount: 0, monthlyCount: 0, monthlyLimit: limit })).toBeNull()
  })

  test('a second concurrent job is refused with 409 -- worker concurrency is 1', () => {
    const v = quotaVerdict({ activeCount: 1, monthlyCount: 1, monthlyLimit: limit })
    expect(v?.status).toBe(409)
    expect(v?.message).toMatch(/already have/i)
  })

  test('the monthly cap refuses with 429, a different problem from a conflict', () => {
    const v = quotaVerdict({ activeCount: 0, monthlyCount: 3, monthlyLimit: limit })
    expect(v?.status).toBe(429)
    expect(v?.message).toMatch(/limit/i)
  })

  test('one under the monthly cap is still allowed', () => {
    expect(quotaVerdict({ activeCount: 0, monthlyCount: 2, monthlyLimit: limit })).toBeNull()
  })

  test('over the monthly cap stays refused, not wrapped around', () => {
    expect(quotaVerdict({ activeCount: 0, monthlyCount: 99, monthlyLimit: limit })?.status).toBe(429)
  })

  test('a running job is reported before the monthly cap: it is the fixable one', () => {
    const v = quotaVerdict({ activeCount: 1, monthlyCount: 3, monthlyLimit: limit })
    expect(v?.status).toBe(409)
  })

  test('a limit of zero refuses everyone, rather than being read as unlimited', () => {
    expect(quotaVerdict({ activeCount: 0, monthlyCount: 0, monthlyLimit: 0 })?.status).toBe(429)
  })
})

describe('quotaVerdict storage', () => {
  const GB = 1024 ** 3
  const ok = { activeCount: 0, monthlyCount: 0, monthlyLimit: 3 }

  test('room to spare is allowed', () => {
    expect(quotaVerdict({ ...ok, storageBytes: 1 * GB, storageLimitBytes: 5 * GB })).toBeNull()
  })

  test('a full disk refuses with 507, not the monthly 429', () => {
    const v = quotaVerdict({ ...ok, storageBytes: 5 * GB, storageLimitBytes: 5 * GB })
    expect(v?.status).toBe(507)
    // The user can act on this one: the message has to say how.
    expect(v?.message).toMatch(/delete/i)
  })

  test('the message names both sides in units a person reads', () => {
    const v = quotaVerdict({ ...ok, storageBytes: 6 * GB, storageLimitBytes: 5 * GB })
    expect(v?.message).toContain('5.0 GB')
  })

  test('one byte under the cap is still allowed', () => {
    expect(
      quotaVerdict({ ...ok, storageBytes: 5 * GB - 1, storageLimitBytes: 5 * GB }),
    ).toBeNull()
  })

  test('a running job is still reported first -- waiting fixes it, deleting does not', () => {
    const v = quotaVerdict({
      activeCount: 1,
      monthlyCount: 0,
      monthlyLimit: 3,
      storageBytes: 9 * GB,
      storageLimitBytes: 5 * GB,
    })
    expect(v?.status).toBe(409)
  })

  test('storage is reported before the monthly cap: freeing space beats waiting a month', () => {
    const v = quotaVerdict({
      activeCount: 0,
      monthlyCount: 3,
      monthlyLimit: 3,
      storageBytes: 9 * GB,
      storageLimitBytes: 5 * GB,
    })
    expect(v?.status).toBe(507)
  })

  test('omitting the storage counts leaves the old two rules untouched', () => {
    // The worker and the tests that predate storage call it without them.
    expect(quotaVerdict(ok)).toBeNull()
  })
})

describe('quotaWindow', () => {
  test('runs from the 1st of this month to the 1st of the next, in UTC', () => {
    const w = quotaWindow(new Date('2026-09-25T01:59:00Z'))
    expect(w.start.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(w.resetsAt.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  test('December resets into January of the next year', () => {
    const w = quotaWindow(new Date('2026-12-31T23:59:59Z'))
    expect(w.start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(w.resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  test('the first instant of a month belongs to that month, not the last', () => {
    const w = quotaWindow(new Date('2026-10-01T00:00:00Z'))
    expect(w.start.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
})
