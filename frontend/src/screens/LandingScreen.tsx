/**
 * The public front page, at /. Visitors only: a signed-in user gets the app at
 * the same address (see publicScreen in useSnipline.ts).
 *
 * Everything claimed here is something the app does today with its default
 * switches -- no editor (it is switched off), no testimonials, no usage numbers.
 * A front page is where a made-up quote does the most harm.
 *
 * The clip tiles are drawn, not screenshots: they cannot go stale when the UI
 * changes, cost nothing to load, and use the same hook badge and caption
 * placement as a real render.
 */
import type { MouseEvent, ReactNode } from 'react'
import { Logo } from '../components/Logo'
import { cn } from '../lib/cn'
import { useApp } from '../state/AppContext'

const TILES = [
  { hook: 91, at: '0:43', line: 'Nobody tells you this part', lift: 'translate-y-0' },
  { hook: 87, at: '0:38', line: 'That was the whole trick', lift: 'translate-y-5' },
  { hook: 94, at: '0:52', line: 'I almost quit right there', lift: '-translate-y-3' },
]

const STEPS = [
  {
    n: '1',
    title: 'Paste a link',
    body: 'A podcast, a stream, a talk — any long video on YouTube. Nothing to upload.',
  },
  {
    n: '2',
    title: 'Say what you want',
    body: 'How many clips, how long, which formats. Add a line like "only the parts about pricing" if you like.',
  },
  {
    n: '3',
    title: 'Post them',
    body: 'Download the clips, or on your phone send one straight into TikTok or Reels.',
  },
]

const FEATURES = [
  {
    title: 'It finds the moments',
    body: 'clip2 reads the whole transcript and scores every moment on how well it hooks a scrolling viewer. The strongest ones become clips.',
  },
  {
    title: 'Ask for more',
    body: 'Not quite what you wanted? Ask in plain words — "more about funding" — and it suggests other moments you can clip in one click.',
  },
  {
    title: 'Subtitles, burned in',
    body: 'Most people watch on mute. Every clip comes with captions timed to the speech, placed clear of the app buttons.',
  },
  {
    title: 'Every shape you need',
    body: '9:16 for TikTok, Reels and Shorts, 1:1 and 4:5 for the feed — from the same run, at 1080p.',
  },
  {
    title: 'Straight to TikTok',
    body: 'On your phone, Share hands a clip to TikTok, Reels or WhatsApp. No saving and re-uploading.',
  },
  {
    title: 'Clean cuts',
    body: 'Every cut lands between words, where the transcript breaks, never mid-word. And no two clips cover the same moment.',
  },
]

/**
 * A real link to /login -- middle-click, copy link and open-in-new-tab all work
 * -- that switches screens in place on a plain click instead of reloading.
 */
function LoginLink({ className, children }: { className: string; children: ReactNode }) {
  const { goLogin } = useApp()
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    goLogin()
  }
  return (
    <a href="/login" onClick={onClick} className={className}>
      {children}
    </a>
  )
}

const primary =
  'inline-flex items-center justify-center rounded-full border-2 border-ink bg-violet px-6 font-semibold text-white shadow-stamp transition-colors hover:bg-violet-deep'
const outline =
  'inline-flex items-center justify-center rounded-full border-2 border-ink bg-white px-5 font-medium text-ink-soft transition-colors hover:bg-cream'

function ClipTile({ tile }: { tile: (typeof TILES)[number] }) {
  return (
    <div
      className={cn(
        'hatch-night relative flex-1 overflow-hidden rounded-[14px] border-2 border-ink shadow-stamp',
        tile.lift,
      )}
      style={{ aspectRatio: '9/16' }}
      aria-hidden="true"
    >
      <span className="absolute top-2.5 left-2.5 -rotate-3 rounded-full border-[1.5px] border-ink bg-lime px-2 py-[3px] text-[10.5px] font-bold text-ink">
        {tile.hook} hook
      </span>
      {/* Where the renderer puts captions: just below the middle. */}
      <span className="absolute inset-x-2 top-[56%] text-center text-[11px] leading-[1.25] font-bold text-white [text-shadow:0_0_3px_#000,0_0_3px_#000]">
        {tile.line}
      </span>
      <span className="absolute right-2.5 bottom-2.5 rounded-[5px] bg-black/60 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
        {tile.at}
      </span>
    </div>
  )
}

export function LandingScreen() {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-cream">
      <header className="sticky top-0 z-20 border-b border-black/8 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-3 px-5 sm:px-8">
          <Logo />
          <nav className="ml-auto flex items-center gap-2.5">
            <LoginLink className="px-2 text-[13.5px] font-medium text-ink-soft hover:text-ink">
              Log in
            </LoginLink>
            <LoginLink className={cn(primary, 'h-10 px-4 text-[13.5px]')}>Get started</LoginLink>
          </nav>
        </div>
      </header>

      <main>
        {/* --- hero --------------------------------------------------------- */}
        <section className="mx-auto grid max-w-[1120px] items-center gap-12 px-5 pt-14 pb-16 sm:px-8 md:pt-20 lg:grid-cols-[1.1fr_.9fr]">
          <div>
            <p className="m-0 mb-4 inline-block rounded-full bg-lime px-3 py-1 text-[12px] font-semibold text-ink">
              Free while in beta
            </p>
            <h1 className="m-0 mb-5 max-w-[560px] font-display text-[40px] leading-[1.05] font-bold tracking-[-0.03em] text-ink sm:text-[54px]">
              Turn one long video into a week of posts.
            </h1>
            <p className="m-0 mb-8 max-w-[480px] text-[16px] leading-[1.6] text-muted">
              Paste a link. clip2 finds the moments worth posting, cuts them to 9:16 with
              subtitles, and hands them to TikTok, Reels and Shorts.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <LoginLink className={cn(primary, 'h-12 text-[15px]')}>Get started free</LoginLink>
              <a href="#how" className={cn(outline, 'h-12 text-[15px]')}>
                See how it works
              </a>
            </div>
            <p className="mt-4 mb-0 text-[12.5px] text-black/45">
              No card. No watermark. Sign in with Google.
            </p>
          </div>

          <div className="mx-auto flex w-full max-w-[420px] gap-3 py-4">
            {TILES.map((t) => (
              <ClipTile key={t.at} tile={t} />
            ))}
          </div>
        </section>

        {/* --- how it works ------------------------------------------------- */}
        <section id="how" className="scroll-mt-16 border-y border-black/8 bg-white">
          <div className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8">
            <h2 className="m-0 mb-10 font-display text-[30px] leading-[1.15] font-bold tracking-[-0.02em] text-ink">
              Three steps, a few minutes of your time.
            </h2>
            <ol className="m-0 grid list-none gap-5 p-0 md:grid-cols-3">
              {STEPS.map((s) => (
                <li
                  key={s.n}
                  className="rounded-[18px] border-[1.5px] border-[rgba(23,20,18,.16)] bg-cream p-6"
                >
                  <span className="mb-4 flex size-9 items-center justify-center rounded-full border-2 border-ink bg-lime font-display text-[16px] font-bold text-ink">
                    {s.n}
                  </span>
                  <h3 className="m-0 mb-2 text-[16px] font-semibold text-ink">{s.title}</h3>
                  <p className="m-0 text-[14px] leading-[1.6] text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 mb-0 text-[13px] text-black/45">
              The clips render while you do something else — a long video takes a while. You can
              close the tab and come back.
            </p>
          </div>
        </section>

        {/* --- features ----------------------------------------------------- */}
        <section className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8">
          <h2 className="m-0 mb-10 font-display text-[30px] leading-[1.15] font-bold tracking-[-0.02em] text-ink">
            The boring part, done for you.
          </h2>
          <ul className="m-0 grid list-none gap-x-8 gap-y-9 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <h3 className="m-0 mb-2 flex items-center gap-2 text-[15.5px] font-semibold text-ink">
                  <span className="size-2 flex-none rounded-full bg-violet" aria-hidden="true" />
                  {f.title}
                </h3>
                <p className="m-0 text-[14px] leading-[1.6] text-muted">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* --- closing call ------------------------------------------------- */}
        <section className="px-5 pb-16 sm:px-8">
          <div className="mx-auto max-w-[1120px] rounded-[24px] border-2 border-ink bg-night px-6 py-12 text-center shadow-stamp-lg sm:px-12">
            <h2 className="m-0 mb-3 font-display text-[30px] leading-[1.15] font-bold tracking-[-0.02em] text-white sm:text-[36px]">
              Your next week of posts is already recorded.
            </h2>
            <p className="m-0 mb-7 text-[15px] text-white/65">
              Free during the beta, with a monthly limit per account.
            </p>
            <LoginLink className={cn(primary, 'h-12 text-[15px]')}>Get started free</LoginLink>
          </div>
        </section>
      </main>

      <footer className="border-t border-black/8">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-6 text-[12.5px] text-black/45 sm:px-8">
          <Logo size="sm" />
          <span>Only download videos you have the right to use.</span>
        </div>
      </footer>
    </div>
  )
}
