/**
 * Argument parsing for the quota script.
 *
 * Split out from the database work so the part that can silently do the wrong
 * thing -- "--limit 0" meaning "block this user" versus meaning "no value" --
 * is testable without a Postgres.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs } from './quota.ts'

describe('quota script arguments', () => {
  test('an email alone is a read-only status check', () => {
    expect(parseArgs(['a@b.com'])).toEqual({
      email: 'a@b.com',
      limit: undefined,
      storageBytes: undefined,
      release: false,
    })
  })

  test('--limit sets a per-user override', () => {
    expect(parseArgs(['a@b.com', '--limit', '20'])).toMatchObject({
      email: 'a@b.com',
      limit: 20,
      release: false,
    })
  })

  test('--limit default clears the override', () => {
    // null is the value written to the column, which is what makes the user
    // follow QUOTA_JOBS_PER_MONTH again.
    expect(parseArgs(['a@b.com', '--limit', 'default'])).toMatchObject({
      email: 'a@b.com',
      limit: null,
      release: false,
    })
  })

  test('--limit 0 is a real value, not a missing one', () => {
    expect(parseArgs(['a@b.com', '--limit', '0'])).toMatchObject({ limit: 0 })
  })

  test('--release asks to clear a stuck running job', () => {
    expect(parseArgs(['a@b.com', '--release'])).toMatchObject({ release: true })
  })

  test('both at once', () => {
    expect(parseArgs(['a@b.com', '--release', '--limit', '5'])).toMatchObject({
      email: 'a@b.com',
      limit: 5,
      release: true,
    })
  })

  test('--storage takes GB, because that is the unit a person says', () => {
    expect(parseArgs(['a@b.com', '--storage', '20'])).toMatchObject({
      storageBytes: 20 * 1024 ** 3,
    })
  })

  test('a fraction of a GB is allowed and lands on whole bytes', () => {
    const { storageBytes } = parseArgs(['a@b.com', '--storage', '0.5'])
    expect(storageBytes).toBe(0.5 * 1024 ** 3)
    expect(Number.isInteger(storageBytes)).toBe(true)
  })

  test('--storage default clears the override', () => {
    expect(parseArgs(['a@b.com', '--storage', 'default'])).toMatchObject({ storageBytes: null })
  })

  test('--storage 0 is a real value, not a missing one', () => {
    expect(parseArgs(['a@b.com', '--storage', '0'])).toMatchObject({ storageBytes: 0 })
  })

  test('a junk or negative storage value is an error rather than NaN in the column', () => {
    expect(() => parseArgs(['a@b.com', '--storage', 'lots'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--storage'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--storage', '-1'])).toThrow()
  })

  test('no email is an error, not a run against every user', () => {
    expect(() => parseArgs([])).toThrow()
    expect(() => parseArgs(['--limit', '5'])).toThrow()
  })

  test('a non-numeric limit is an error rather than NaN in the column', () => {
    expect(() => parseArgs(['a@b.com', '--limit', 'lots'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--limit'])).toThrow()
  })

  test('a negative limit is an error', () => {
    expect(() => parseArgs(['a@b.com', '--limit', '-1'])).toThrow()
  })
})
