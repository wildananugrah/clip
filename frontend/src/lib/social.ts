/**
 * Caption suggestions as text to paste. The server stores hashtags without the
 * '#', so this is the one place it is added.
 */

export function hashtagLine(tags: string[]): string {
  return tags.map((t) => `#${t}`).join(' ')
}

/** Caption, a blank line, then the tags: how people lay out a post. */
export function postText(caption: string, tags: string[]): string {
  const line = hashtagLine(tags)
  return line ? `${caption}\n\n${line}` : caption
}
