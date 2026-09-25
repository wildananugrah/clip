/**
 * Environment validation. Fails loudly at boot rather than at the first request,
 * because a missing credential would otherwise silently leave the API open.
 */
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3004),
  HOST: z.string().default('127.0.0.1'),
  /**
   * HMAC key for signed media URLs, and nothing else since Tier C.
   *
   * It used to gate every /api route, but the SPA read it at build time, so it
   * shipped inside the JS bundle and was never a secret. Sessions replaced it as
   * the access credential; it survives only as the signing key in
   * shared/mediaToken.ts, where being long and random is all that is asked of it.
   */
  API_TOKEN: z.string().min(16, 'API_TOKEN must be at least 16 chars (openssl rand -hex 32)'),

  // Google OAuth. No defaults: an unset pair must stop the boot rather than
  // leave every /api route reachable with no way to sign in.
  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required (Google Cloud Console)'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  /** How long a login lasts. Nothing here calls a Google API, so there is no refresh. */
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  /** Per-user jobs per calendar month (UTC). Worker concurrency is 1; see quota.ts. */
  QUOTA_JOBS_PER_MONTH: z.coerce.number().default(20),
  /** Per-user rendered GB. In GB, not bytes, because a human sets it. */
  QUOTA_STORAGE_GB: z.coerce.number().default(5),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * The clip editor: trimming, the timeline, manual clipping, save-as-new-clip.
   *
   * TEMPORARILY OFF while the editor page is being reworked. This is the single
   * switch for the whole feature -- it hides the only way in (the Edit chip on
   * the results screen) AND makes the editor-only routes 404, so a bookmark or
   * a direct API call cannot reach it either.
   *
   * DEFAULTS TO FALSE, unlike every other flag here. An unset variable has to
   * mean "off": the point of this switch is that nobody reaches the feature,
   * and a default that fails open would be re-enabled by forgetting.
   *
   * The frontend is a static build and cannot read this, so it is published on
   * GET /api/auth/me and the UI reads it from there -- one variable, both
   * halves, no rebuild to flip it.
   */
  EDITOR_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Clip recommendations: the suggested-moments list on the results screen and
   * the chat that regenerates it. Same two halves as EDITOR_ENABLED -- it hides
   * the panel AND 404s the routes behind it.
   *
   * DEFAULTS TO TRUE, unlike EDITOR_ENABLED. The two flags exist for opposite
   * reasons: that one is off while its feature is reworked and must not come
   * back by forgetting, this one is an off switch for a feature that is meant
   * to be on -- the lever to pull if the model bill needs stopping.
   */
  RECOMMENDATIONS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  /**
   * The API talks to OpenRouter for one thing only: the recommendation chat.
   *
   * It is a duplicate of the worker's config rather than a shared secret store
   * because the two processes deploy separately and either may run without the
   * other. The key is optional here, and only here -- the worker cannot pick
   * clips without it, whereas the API just refuses one feature. See
   * recommendationConfig below for where that refusal is turned into a 503.
   */
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.5-flash'),
  /**
   * Publicly reachable origin of this API. Not the same as HOST:PORT when nginx
   * terminates TLS in front; signed media URLs are built against it, so getting
   * it wrong yields links the browser cannot reach.
   */
  PUBLIC_API_URL: z.string().default('http://localhost:3014'),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  YTDLP_MAX_AGE_DAYS: z.coerce.number().default(60),
  MIN_FREE_DISK_GB: z.coerce.number().default(5),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env and fill it in.`)
  process.exit(1)
}

export const env = parsed.data

export const corsOrigins = env.CORS_ORIGIN.split(',').map((s) => s.trim())

/**
 * Derived, never configured. Google matches the redirect_uri exactly against the
 * client's registered value, and a separate env var is one more thing that can
 * disagree with PUBLIC_API_URL. Must match the "Authorized redirect URI" in the
 * Google Cloud Console entry for GOOGLE_CLIENT_ID.
 */
export const oauthRedirectUri = `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/auth/google/callback`

/**
 * OpenRouter settings for the recommendation chat, or null when there is no key.
 *
 * Null rather than a boot failure: a missing key disables one panel, and taking
 * the whole API down for it would be a worse outage than the one it prevents.
 * The routes turn null into a 503 with something a user can act on.
 */
export const recommendationConfig = env.OPENROUTER_API_KEY
  ? {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      model: env.OPENROUTER_MODEL,
    }
  : null
