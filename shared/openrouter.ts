/**
 * The one place that talks to the model: clip ranges, and the captions and
 * hashtags for posting a clip.
 *
 * The model is given the TRANSCRIPT WITH TIMESTAMPS, never the video. That is
 * deliberate: shown a video, Gemini emits MM:SS, which is ambiguous past one
 * hour and silently yields clips past the end of the source (a trap documented
 * in clipper's unbuilt cutlist.py design). Working from segments we supplied,
 * it returns float seconds and the ambiguity cannot arise.
 *
 * Nothing returned here is trusted: see clipRanges.ts.
 *
 * Configuration arrives as an argument rather than through an `env` import, so
 * the worker and the API can each supply their own and a test can supply
 * neither. `fetch` is injectable for the same reason `subscribe` takes its deps
 * in frontend/src/lib/api.ts -- a test should be able to assert what was sent
 * without a network.
 */
import { z } from 'zod'
import type { Candidate } from './clipRanges.ts'
import { extractJson } from './clipPrompt.ts'
import { cleanSocialCopy } from './socialCopy.ts'

const responseSchema = z.object({
  clips: z
    .array(
      z.object({
        title: z.string(),
        start: z.number(),
        end: z.number(),
        score: z.number(),
        snippet: z.string().optional().default(''),
        caption: z.string().optional().default(''),
        line: z.string().optional().default(''),
      }),
    )
    .default([]),
})

export const CLIP_JSON_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Punchy headline for the moment, max 60 chars' },
          start: { type: 'number', description: 'Start time in seconds' },
          end: { type: 'number', description: 'End time in seconds' },
          score: { type: 'number', description: 'Hook strength 0-100' },
          snippet: { type: 'string', description: 'Short transcript excerpt from the moment' },
          caption: { type: 'string', description: 'Suggested social caption, one sentence' },
          line: { type: 'string', description: 'The single most quotable phrase, max 40 chars' },
        },
        required: ['title', 'start', 'end', 'score', 'snippet', 'caption', 'line'],
        additionalProperties: false,
      },
    },
  },
  required: ['clips'],
  additionalProperties: false,
} as const

export interface OpenRouterConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface RequestClipsOptions {
  prompt: string
  config: OpenRouterConfig
  signal?: AbortSignal
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * One strict-JSON completion: POST, unwrap, parse. Returns the decoded object
 * for the caller's own schema to judge.
 *
 * Shared by every request below so they fail the same way -- a non-2xx, an
 * empty reply and unparseable JSON each throw with a message naming which.
 */
async function completeJson(
  opts: RequestClipsOptions,
  schemaName: string,
  schema: object,
  temperature: number,
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch

  const res = await doFetch(`${opts.config.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      Authorization: `Bearer ${opts.config.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'clip-pipeline',
    },
    body: JSON.stringify({
      model: opts.config.model,
      messages: [{ role: 'user', content: opts.prompt }],
      temperature,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenRouter returned ${res.status}: ${body.slice(0, 300)}`)
  }

  const payload = (await res.json()) as any
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned an empty response.')
  }

  return JSON.parse(extractJson(content))
}

export async function requestClips(opts: RequestClipsOptions): Promise<Candidate[]> {
  const parsed = responseSchema.safeParse(await completeJson(opts, 'clips', CLIP_JSON_SCHEMA, 0.4))
  if (!parsed.success) {
    throw new Error(`OpenRouter returned unusable JSON: ${parsed.error.issues[0]?.message}`)
  }

  return parsed.data.clips.map((c) => ({
    title: c.title,
    start: c.start,
    end: c.end,
    score: c.score,
    snippet: c.snippet,
    caption: c.caption,
    line: c.line,
  }))
}

const socialSchema = z.object({
  captions: z.array(z.string()),
  hashtags: z.array(z.string()),
})

export const SOCIAL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    captions: {
      type: 'array',
      items: { type: 'string', description: 'A caption to post with the clip, no hashtags' },
    },
    hashtags: {
      type: 'array',
      items: { type: 'string', description: 'A hashtag without the leading #' },
    },
  },
  required: ['captions', 'hashtags'],
  additionalProperties: false,
} as const

/**
 * Caption options and hashtags for one clip. See socialCopy.ts for the prompt.
 *
 * Warmer than requestClips: there the model is ranking moments and variety is
 * noise, here variety between the options is the point.
 */
export async function requestSocialCopy(
  opts: RequestClipsOptions,
): Promise<{ captions: string[]; hashtags: string[] }> {
  const parsed = socialSchema.safeParse(
    await completeJson(opts, 'social_copy', SOCIAL_JSON_SCHEMA, 0.8),
  )
  if (!parsed.success) {
    throw new Error(`OpenRouter returned unusable JSON: ${parsed.error.issues[0]?.message}`)
  }
  return cleanSocialCopy(parsed.data)
}
