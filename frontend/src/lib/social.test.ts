/**
 * How caption suggestions become text on the clipboard. The server keeps tags
 * bare, so every '#' the user pastes is added here.
 */
import { test, expect, describe } from 'bun:test'
import { hashtagLine, postText, sourceCredit, timestampedUrl } from './social'
import type { ClipSource } from '../types'

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

describe('postText with a source', () => {
  test('caption, then the credit, then the tags, each a paragraph', () => {
    expect(postText('Stop billing hours.', ['pricing'], 'Source: Close The Door (YouTube)')).toBe(
      'Stop billing hours.\n\nSource: Close The Door (YouTube)\n\n#pricing',
    )
  })

  test('skips an empty credit', () => {
    expect(postText('Stop billing hours.', ['pricing'], '')).toBe('Stop billing hours.\n\n#pricing')
  })
})

describe('timestampedUrl', () => {
  test('opens a youtube.com watch link at the clip', () => {
    expect(timestampedUrl('https://www.youtube.com/watch?v=abc123', 754.6)).toBe(
      'https://www.youtube.com/watch?v=abc123&t=754s',
    )
  })

  test('opens a youtu.be link at the clip', () => {
    expect(timestampedUrl('https://youtu.be/abc123', 90)).toBe('https://youtu.be/abc123?t=90s')
  })

  test('replaces a timestamp the source link already had', () => {
    expect(timestampedUrl('https://youtu.be/abc123?t=5', 90)).toBe('https://youtu.be/abc123?t=90s')
  })

  test('leaves a clip from the very start untouched', () => {
    expect(timestampedUrl('https://youtu.be/abc123', 0)).toBe('https://youtu.be/abc123')
  })

  // Other platforms either ignore ?t= or mean something else by it.
  test('leaves other platforms alone', () => {
    expect(timestampedUrl('https://www.tiktok.com/@x/video/1', 90)).toBe(
      'https://www.tiktok.com/@x/video/1',
    )
  })

  test('passes through something that is not a URL', () => {
    expect(timestampedUrl('not a url', 90)).toBe('not a url')
  })
})

describe('sourceCredit', () => {
  const source: ClipSource = {
    channel: 'Close The Door',
    platform: 'YouTube',
    title: 'Episode 12: Pricing',
    url: 'https://youtu.be/abc123',
  }

  test('channel and platform, the episode title, then a link to the moment', () => {
    expect(sourceCredit(source, 754)).toBe(
      'Source: Close The Door (YouTube)\n"Episode 12: Pricing"\nhttps://youtu.be/abc123?t=754s',
    )
  })

  test('names just the platform when the channel is unknown', () => {
    expect(sourceCredit({ ...source, channel: null }, 0)).toBe(
      'Source: YouTube\n"Episode 12: Pricing"\nhttps://youtu.be/abc123',
    )
  })
})
