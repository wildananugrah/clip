/**
 * Caption suggestions as text to paste. The server stores hashtags without the
 * '#', so this is the one place it is added.
 */
import type { ClipSource } from '../types'

export function hashtagLine(tags: string[]): string {
  return tags.map((t) => `#${t}`).join(' ')
}

/**
 * Caption, then the source credit when there is one, then the tags, each its
 * own paragraph: how people lay out a post.
 */
export function postText(caption: string, tags: string[], credit = ''): string {
  return [caption, credit, hashtagLine(tags)].filter(Boolean).join('\n\n')
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'])

/**
 * The source link, opened at the clip's first second where the platform
 * understands that. Only YouTube does, reliably: elsewhere ?t= is ignored or
 * means something else, so the link is left as it was.
 */
export function timestampedUrl(url: string, startSeconds: number): string {
  const at = Math.floor(startSeconds)
  if (at <= 0) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return url
  parsed.searchParams.set('t', `${at}s`)
  return parsed.toString()
}

/** "Source: channel (platform)", the episode title, then a link to the moment. */
export function sourceCredit(source: ClipSource, startSeconds: number): string {
  const who = source.channel ? `${source.channel} (${source.platform})` : source.platform
  return [`Source: ${who}`, `"${source.title}"`, timestampedUrl(source.url, startSeconds)].join('\n')
}
