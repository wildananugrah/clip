import { test, expect, describe } from 'bun:test'
import { buildSocialPrompt, cleanSocialCopy, clipTranscript } from './socialCopy.ts'
import { requestSocialCopy } from './openrouter.ts'
import { MAX_HASHTAGS, SOCIAL_CAPTIONS } from './types.ts'
import type { TranscriptSegment } from './schema.ts'

const segments: TranscriptSegment[] = [
  { start: 0, end: 5, text: 'Welcome back to the show.' },
  { start: 5, end: 12, text: 'Most founders price by the hour.' },
  { start: 12, end: 20, text: 'That is the mistake.' },
  { start: 20, end: 30, text: 'Thanks to our sponsor.' },
]

describe('clipTranscript', () => {
  test('keeps only what is said inside the clip', () => {
    expect(clipTranscript(segments, 6, 19)).toBe(
      'Most founders price by the hour. That is the mistake.',
    )
  })

  // A line straddling the in or out point is still half heard in the clip.
  test('keeps lines that straddle either edge', () => {
    expect(clipTranscript(segments, 4, 13)).toContain('Welcome back')
    expect(clipTranscript(segments, 4, 13)).toContain('That is the mistake.')
  })

  test('is empty when nothing is said in the range', () => {
    expect(clipTranscript(segments, 40, 50)).toBe('')
  })
})

describe('buildSocialPrompt', () => {
  const prompt = buildSocialPrompt({
    clipTitle: 'The pricing mistake',
    videoTitle: 'Founder podcast #12',
    transcript: 'Most founders price by the hour.',
    language: 'id',
  })

  test('carries the clip, the video and the words', () => {
    expect(prompt).toContain('The pricing mistake')
    expect(prompt).toContain('Founder podcast #12')
    expect(prompt).toContain('Most founders price by the hour.')
  })

  test('asks for the counts the UI shows', () => {
    expect(prompt).toContain(`${SOCIAL_CAPTIONS} caption`)
    expect(prompt).toContain(`${MAX_HASHTAGS}`)
  })

  test('pins the language to the transcript', () => {
    expect(prompt).toMatch(/same language as the transcript/)
    expect(prompt).toContain('"id"')
  })

  test('omits the language hint when whisper did not record one', () => {
    const p = buildSocialPrompt({
      clipTitle: 't',
      videoTitle: 'v',
      transcript: 'x',
      language: null,
    })
    expect(p).toMatch(/same language as the transcript/)
    expect(p).not.toContain('language code')
  })
})

describe('cleanSocialCopy', () => {
  test('strips the # and anything a hashtag cannot contain', () => {
    const out = cleanSocialCopy({
      captions: ['One.'],
      hashtags: ['#startup', 'pricing tips', '##saas!', 'bisnisOnline'],
    })
    expect(out.hashtags).toEqual(['startup', 'pricingtips', 'saas', 'bisnisOnline'])
  })

  test('drops duplicates regardless of case, and empties', () => {
    const out = cleanSocialCopy({
      captions: ['Same.', ' Same. ', '', 'Other.'],
      hashtags: ['Startup', 'startup', '#', '  '],
    })
    expect(out.captions).toEqual(['Same.', 'Other.'])
    expect(out.hashtags).toEqual(['Startup'])
  })

  test('caps both lists at what the UI shows', () => {
    const out = cleanSocialCopy({
      captions: Array.from({ length: 6 }, (_, i) => `Caption ${i}`),
      hashtags: Array.from({ length: 30 }, (_, i) => `tag${i}`),
    })
    expect(out.captions).toHaveLength(SOCIAL_CAPTIONS)
    expect(out.hashtags).toHaveLength(MAX_HASHTAGS)
  })

  // Hashtags have their own row; a caption ending in them would post them twice.
  test('removes trailing hashtags the model tucked into a caption', () => {
    const out = cleanSocialCopy({ captions: ['Stop billing hours. #startup #saas'], hashtags: [] })
    expect(out.captions).toEqual(['Stop billing hours.'])
  })

  test('keeps non-latin hashtags intact', () => {
    const out = cleanSocialCopy({ captions: ['x'], hashtags: ['#日本語', 'café'] })
    expect(out.hashtags).toEqual(['日本語', 'café'])
  })

  test('refuses a response with no usable caption', () => {
    expect(() => cleanSocialCopy({ captions: ['  ', '#only #tags'], hashtags: ['a'] })).toThrow()
  })
})

describe('requestSocialCopy', () => {
  const config = { apiKey: 'k', baseUrl: 'https://or.test/api/v1', model: 'm' }

  const reply = (content: string, status = 200): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
      })) as unknown as typeof fetch

  test('sends the prompt under a strict schema and cleans what comes back', async () => {
    let sent: any = null
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string)
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"captions":["A.","B."],"hashtags":["#one","two"]}' } },
          ],
        }),
      )
    }) as unknown as typeof fetch

    const out = await requestSocialCopy({ prompt: 'PROMPT', config, fetchImpl })

    expect(sent.messages[0].content).toBe('PROMPT')
    expect(sent.response_format.json_schema.strict).toBe(true)
    expect(sent.response_format.json_schema.name).toBe('social_copy')
    expect(out).toEqual({ captions: ['A.', 'B.'], hashtags: ['one', 'two'] })
  })

  test('surfaces a non-2xx as an error', async () => {
    await expect(
      requestSocialCopy({ prompt: 'p', config, fetchImpl: reply('nope', 500) }),
    ).rejects.toThrow(/500/)
  })

  test('rejects JSON of the wrong shape', async () => {
    await expect(
      requestSocialCopy({ prompt: 'p', config, fetchImpl: reply('{"clips":[]}') }),
    ).rejects.toThrow()
  })
})
