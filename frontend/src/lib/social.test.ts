/**
 * How caption suggestions become text on the clipboard. The server keeps tags
 * bare, so every '#' the user pastes is added here.
 */
import { test, expect, describe } from 'bun:test'
import { hashtagLine, postText } from './social'

describe('hashtagLine', () => {
  test('prefixes each tag and joins with spaces', () => {
    expect(hashtagLine(['pricing', 'startup'])).toBe('#pricing #startup')
  })

  test('is empty with no tags', () => {
    expect(hashtagLine([])).toBe('')
  })
})

describe('postText', () => {
  test('caption, a blank line, then the tags -- how people post them', () => {
    expect(postText('Stop billing hours.', ['pricing', 'startup'])).toBe(
      'Stop billing hours.\n\n#pricing #startup',
    )
  })

  test('just the caption when there are no tags', () => {
    expect(postText('Stop billing hours.', [])).toBe('Stop billing hours.')
  })
})
