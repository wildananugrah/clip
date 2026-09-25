import type { Ratio, SourceKey } from '../types'

/** A clip without its server fields. Only the editor prototype still uses these. */
export interface ClipSeed {
  t: string
  s: number
  e: number
  sc: number
  sn: string
  cap: string
  line: string
}

/**
 * PROTOTYPE DATA. The results grid and the editor are served by the API now;
 * these remain only to give the processing screen's placeholder rows something
 * to show while a real job is still rendering.
 */
export const CLIPS: ClipSeed[] = [
  {
    t: '"I almost deleted the whole repo"',
    s: 842,
    e: 884,
    sc: 92,
    sn: '…so I’m sitting there at 2am and the migration just wiped the dev database, and honestly…',
    cap: 'I wiped my own database at 2am. Here’s what saved me.',
    line: 'the migration just\nwiped the dev database',
  },
  {
    t: 'The pricing mistake everyone makes',
    s: 2238,
    e: 2293,
    sc: 88,
    sn: '…charge for the outcome, not the hours. The second I switched, the same work paid three times…',
    cap: 'Stop charging for hours. Charge for the outcome.',
    line: 'charge for the outcome,\nnot the hours',
  },
  {
    t: 'Why I stopped using templates',
    s: 3160,
    e: 3198,
    sc: 74,
    sn: '…every template starts you at the same place as everyone else, which is the one place…',
    cap: 'Templates put you exactly where everyone else already is.',
    line: 'every template starts you\nwhere everyone else is',
  },
  {
    t: "Reading the chat's worst take",
    s: 4075,
    e: 4139,
    sc: 69,
    sn: '…someone just said I should rewrite it in assembly. Genuinely. Let’s talk about that…',
    cap: 'Chat told me to rewrite it in assembly. Genuinely.',
    line: 'rewrite it in assembly?\ngenuinely?',
  },
  {
    t: 'The first hour is always fake work',
    s: 520,
    e: 567,
    sc: 66,
    sn: '…setting up the project is not the project. I wasted an hour on folder names…',
    cap: 'Setting up the project is not the project.',
    line: 'setting up the project\nis not the project',
  },
  {
    t: 'How I pick what to build next',
    s: 1450,
    e: 1502,
    sc: 61,
    sn: '…if I can’t explain who it’s for in one sentence, I don’t start it…',
    cap: 'If you can’t say who it’s for in one sentence, don’t build it.',
    line: 'one sentence,\nor don’t build it',
  },
  {
    t: 'Shipping ugly on purpose',
    s: 5240,
    e: 5289,
    sc: 58,
    sn: '…it looked bad and people still paid, which told me the thing I needed to know…',
    cap: 'It looked bad. People paid anyway. That was the signal.',
    line: 'it looked bad.\npeople paid anyway.',
  },
  {
    t: 'The part nobody warns you about',
    s: 5900,
    e: 5961,
    sc: 55,
    sn: '…the support inbox is the product. I did not understand that for a year…',
    cap: 'The support inbox is the product.',
    line: 'the support inbox\nis the product',
  },
  {
    t: 'Two hours of debugging, one typo',
    s: 6520,
    e: 6558,
    sc: 51,
    sn: '…it was a missing s. Two hours. A missing s…',
    cap: 'Two hours of debugging. One missing character.',
    line: 'two hours.\na missing s.',
  },
  {
    t: 'What I’d do differently on day one',
    s: 6980,
    e: 7042,
    sc: 47,
    sn: '…I’d post the ugly version on day one instead of month four…',
    cap: 'Post the ugly version on day one.',
    line: 'post the ugly version\non day one',
  },
  {
    t: 'Answering the question I get most',
    s: 100,
    e: 148,
    sc: 43,
    sn: '…no, you don’t need to quit your job to start. I still haven’t…',
    cap: 'You don’t need to quit your job to start.',
    line: 'you don’t need to quit\nyour job to start',
  },
  {
    t: 'Signing off at 3am',
    s: 7060,
    e: 7104,
    sc: 38,
    sn: '…that’s it, that’s the stream. Go back up your database…',
    cap: 'That’s the stream. Go back up your database.',
    line: 'go back up\nyour database',
  },
]

/**
 * Links the "or try one of these" buttons paste into the box.
 *
 * These replace the old SOURCES fixture: source metadata is resolved by the
 * server from the URL now, so the app only needs something real to analyse.
 */
export const SAMPLE_URLS: Record<SourceKey, string> = {
  podcast: 'https://www.youtube.com/watch?v=by3MhO0xVng',
  stream: 'https://www.youtube.com/watch?v=zSuUI7J1OaU',
}

export const LENGTHS = ['<30s', '30–60s', '60–90s']

export const RATIOS: Ratio[] = ['9:16', '1:1', '4:5']

export const CLIP_COUNTS = [6, 12, 24]

/**
 * Bounds for a custom clip count.
 *
 * These MIRROR the API's own validation in backend/src/routes/jobs.ts
 * (`count: z.number().int().min(1).max(24)`). Keep them in step: the server is
 * authoritative and will answer 400 for anything outside this range.
 *
 * The ceiling is not arbitrary -- every clip is a separate ffmpeg cut, reframe
 * and subtitle burn on a 4-core box, and the monthly quota counts jobs rather than
 * clips, so an uncapped number would let one job hold the worker for hours.
 */
export const CLIP_COUNT_MIN = 1
export const CLIP_COUNT_MAX = 24
/** Used when the box is empty or unparseable, matching initialState.count. */
export const CLIP_COUNT_DEFAULT = 12

export const COUNT_HINTS = ['quick pass', 'recommended', 'go wide']

/**
 * Longest single message in the recommendation chat. Mirrors MAX_CHAT_CHARS in
 * shared/types.ts, which is what the API validates against -- the frontend
 * declares its own view of wire constants rather than importing across the
 * workspace, so keep the two in step.
 */
export const MAX_CHAT_CHARS = 280

/**
 * Audio levels behind the trim track, as percentages of the strip height.
 *
 * A fallback only: the editor draws `clip.peaks` measured from the real audio,
 * and falls back to this shape for clips made before peaks were stored.
 */
export const WAVE = [
  30, 52, 38, 70, 44, 86, 60, 34, 76, 48, 64, 40, 92, 56, 36, 68, 44, 80, 50, 32, 72, 58, 42, 88,
  54, 38, 66, 46,
]

/** Rendered output size per format. */
export const EXPORT_SIZES: Record<Ratio, string> = {
  '9:16': '1080×1920 · MP4',
  '1:1': '1080×1080 · MP4',
  '4:5': '1080×1350 · MP4',
}

/** Videos a free beta account gets each month. */
export const FREE_VIDEO_ALLOWANCE = 3

/**
 * The stretch of source the editor timeline shows, in seconds.
 *
 * These MIRROR EDITOR_LEAD_IN and EDITOR_SPAN in shared/types.ts, which the
 * worker encodes each proxy to. Keep them in step: a clip carries its own
 * window now, and these are only the fallback for clips that have none.
 */
export const TIMELINE_LEAD_IN = 30
export const TIMELINE_SPAN = 150
