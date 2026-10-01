/**
 * Captions and hashtags for posting one clip: the prompt, and the cleanup of
 * what comes back.
 *
 * Pure, for the reason clipPrompt.ts gives: no env and no I/O, so both halves
 * are testable on a clean checkout. The model call itself is in openrouter.ts.
 *
 * Separate from the clip-picking prompt on purpose. That prompt already writes
 * one caption per clip, but it writes it for twenty moments at once from the
 * whole transcript; this one reads only the words inside a single clip, so its
 * options can be specific to what the viewer actually hears.
 */
import type { TranscriptSegment } from './schema.ts'
import { MAX_HASHTAGS, SOCIAL_CAPTIONS } from './types.ts'

/** Longest caption kept. Generous: TikTok allows thousands, but nobody reads them. */
const MAX_CAPTION_CHARS = 300
/** Longest hashtag kept. Anything past this is a sentence with the spaces removed. */
const MAX_HASHTAG_CHARS = 40

/**
 * What is said inside the clip, as one paragraph.
 *
 * Overlapping, not contained, as GET /clips/:id/transcript does: a line that
 * straddles the in or out point is still half heard in the clip.
 */
export function clipTranscript(segments: TranscriptSegment[], start: number, end: number): string {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SocialPromptOptions {
  clipTitle: string
  videoTitle: string
  /** From clipTranscript. */
  transcript: string
  /** Whisper's detected language code, when it recorded one. */
  language: string | null
}

export function buildSocialPrompt(opts: SocialPromptOptions): string {
  const languageLine = opts.language
    ? `- Write in the same language as the transcript (whisper detected language code "${opts.language}").`
    : `- Write in the same language as the transcript.`

  return [
    `You are writing the post for one short vertical clip on TikTok, Reels and Shorts.`,
    ``,
    `Clip headline: ${opts.clipTitle}`,
    `It was cut from a longer video titled: ${opts.videoTitle}`,
    ``,
    `This is everything said in the clip:`,
    opts.transcript,
    ``,
    `Write ${SOCIAL_CAPTIONS} caption options and between 8 and ${MAX_HASHTAGS} hashtags.`,
    ``,
    `Rules:`,
    `- Each caption is one or two sentences that make a scrolling viewer stop and watch.`,
    `- Make the options genuinely different: for example a question, a bold claim,`,
    `  and a teaser of what happens in the clip.`,
    `- Base every caption on what is actually said in the clip. Do not invent facts.`,
    `- Captions must not contain hashtags; those go in the hashtags list.`,
    `- An emoji or two is fine; do not overdo it.`,
    `- Hashtags: specific to the topic first, then a few broader ones people search.`,
    `  No '#' prefix, no spaces.`,
    languageLine,
  ].join('\n')
}

/** A run of hashtags at the end of a caption, with the space before it. */
const TRAILING_TAGS = /(?:\s*#[^\s#]+)+\s*$/u
/** Everything a hashtag cannot contain. Letters and digits in any script survive. */
const NOT_TAG_CHARS = /[^\p{L}\p{N}\p{M}_]/gu

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((v) => {
    const key = v.toLocaleLowerCase()
    if (!v || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The trust boundary for model output, as clipRanges.ts is for ranges.
 *
 * The strict schema guarantees the shape, not the contents: models still prefix
 * tags with '#', repeat themselves, tuck hashtags into a caption, or return
 * more than asked. Throws when nothing usable is left, so the caller reports a
 * failure rather than saving an empty panel the user would have to regenerate.
 */
export function cleanSocialCopy(raw: { captions: string[]; hashtags: string[] }): {
  captions: string[]
  hashtags: string[]
} {
  const captions = dedupe(
    raw.captions.map((c) => c.replace(TRAILING_TAGS, '').trim().slice(0, MAX_CAPTION_CHARS)),
  ).slice(0, SOCIAL_CAPTIONS)

  const hashtags = dedupe(
    raw.hashtags.map((h) => h.replace(NOT_TAG_CHARS, '').slice(0, MAX_HASHTAG_CHARS)),
  ).slice(0, MAX_HASHTAGS)

  if (captions.length === 0) throw new Error('The model returned no usable captions.')

  return { captions, hashtags }
}
