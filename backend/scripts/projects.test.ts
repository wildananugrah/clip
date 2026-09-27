/**
 * Argument parsing for the projects script, testable without a Postgres --
 * "--limit 0" meaning "no new projects" versus meaning "no value" is the part
 * that could silently do the wrong thing.
 */
import { test, expect, describe } from 'bun:test'
import { parseArgs } from './projects.ts'

describe('projects script arguments', () => {
  test('an email alone is a read-only status check', () => {
    expect(parseArgs(['a@b.com'])).toEqual({ email: 'a@b.com', limit: undefined })
  })

  test('--limit sets a per-user override', () => {
    expect(parseArgs(['a@b.com', '--limit', '30'])).toEqual({ email: 'a@b.com', limit: 30 })
  })

  test('--limit default clears the override', () => {
    // null is the value written to the column, which is what makes the user
    // follow QUOTA_PROJECTS again.
    expect(parseArgs(['a@b.com', '--limit', 'default'])).toEqual({ email: 'a@b.com', limit: null })
  })

  test('--limit 0 is a real value, not a missing one', () => {
    expect(parseArgs(['a@b.com', '--limit', '0'])).toMatchObject({ limit: 0 })
  })

  test('the flag may come before the email', () => {
    expect(parseArgs(['--limit', '5', 'a@b.com'])).toEqual({ email: 'a@b.com', limit: 5 })
  })

  test('no email is an error, not a run against every user', () => {
    expect(() => parseArgs([])).toThrow()
    expect(() => parseArgs(['--limit', '5'])).toThrow()
  })

  test('a junk, fractional or negative limit is an error rather than bad data in the column', () => {
    expect(() => parseArgs(['a@b.com', '--limit', 'lots'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--limit'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--limit', '2.5'])).toThrow()
    expect(() => parseArgs(['a@b.com', '--limit', '-1'])).toThrow()
  })

  test('an unknown flag is an error', () => {
    expect(() => parseArgs(['a@b.com', '--storage', '5'])).toThrow()
  })
})
