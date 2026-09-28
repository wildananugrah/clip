import { test, expect, describe } from 'bun:test'
import { parsePref, resolveTheme } from './theme'

describe('resolveTheme', () => {
  test('system follows the device', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  test('an explicit choice beats the device', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('parsePref', () => {
  test('reads back what setThemePref stores', () => {
    expect(parsePref('light')).toBe('light')
    expect(parsePref('dark')).toBe('dark')
  })

  test('nothing stored, or junk, means follow the device', () => {
    expect(parsePref(null)).toBe('system')
    expect(parsePref(undefined)).toBe('system')
    expect(parsePref('DARK')).toBe('system')
    expect(parsePref('"dark"')).toBe('system')
  })
})
