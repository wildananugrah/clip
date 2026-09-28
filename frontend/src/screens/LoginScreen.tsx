import { Button } from '../components/Button'
import { Logo } from '../components/Logo'
import { useApp } from '../state/AppContext'

const SHOWCASE = [
  { at: '0:14', lift: 'translate-y-0' },
  { at: '0:38', lift: 'translate-y-[18px]' },
  { at: '0:52', lift: '-translate-y-[10px]' },
]

/**
 * What the callback puts in `?error=` when a sign-in does not complete, in the
 * user's terms rather than the protocol's.
 */
const ERRORS: Record<string, string> = {
  denied: 'Sign-in was cancelled.',
  state: 'That sign-in link expired or was tampered with. Try again.',
  code: 'Google did not return a sign-in code. Try again.',
  exchange: 'Could not complete sign-in with Google. Try again in a moment.',
}

/** Google's four-colour G. Inline so the login screen needs no network to paint. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="block size-[18px]" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H1.02v2.34A8.99 8.99 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71a5.41 5.41 0 0 1 0-3.42V4.96H1.02a8.99 8.99 0 0 0 0 8.08l2.95-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A8.99 8.99 0 0 0 1.02 4.96l2.95 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}

export function LoginScreen() {
  const { state, signIn, goLanding } = useApp()

  // The callback redirects here with ?error=<code> rather than rendering JSON,
  // because the browser arrives by top-level navigation.
  const code = new URLSearchParams(window.location.search).get('error')
  const error = code ? (ERRORS[code] ?? 'Sign-in failed. Try again.') : null

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 bg-paper lg:grid-cols-[1.05fr_.95fr]">
      <div className="flex flex-col overflow-auto px-6 py-10 sm:px-[52px] sm:py-12">
        <div className="mb-auto">
          {/* Back to the front page. A real link, switched in place on a plain click. */}
          <a
            href="/"
            aria-label="clip2 home"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
              e.preventDefault()
              goLanding()
            }}
            className="inline-block"
          >
            <Logo />
          </a>
        </div>

        <h1 className="mt-6 mb-2.5 max-w-[420px] font-display text-[38px] leading-[1.1] font-bold tracking-[-0.025em] text-ink">
          Turn one long video into a week of posts.
        </h1>
        <p className="mt-0 mb-7 max-w-[340px] text-[14px] leading-[1.6] text-muted">
          Free while we’re in beta. No card, no watermark.
        </p>

        <div className="flex max-w-[352px] flex-col gap-2.5">
          {error && (
            <p
              role="alert"
              className="mt-0 mb-1 rounded-[10px] bg-danger-soft px-3.5 py-2.5 text-[12.5px] leading-[1.45] text-danger-ink"
            >
              {error}
            </p>
          )}

          {/*
            Stays busy until the browser actually leaves for Google, which on a
            slow connection is long enough to click twice.
          */}
          <Button
            onClick={signIn}
            loading={state.pending === 'signIn'}
            className="h-[46px] gap-2.5 text-[14px]"
          >
            {state.pending === 'signIn' ? null : <GoogleMark />}
            Continue with Google
          </Button>

          <p className="mt-3 mb-0 text-[11.5px] leading-[1.5] text-ink/40">
            By continuing you agree to the terms. We only download videos you have the right to use.
          </p>
        </div>
      </div>

      <aside className="hidden flex-col justify-center gap-6 overflow-hidden bg-night px-11 py-12 lg:flex">
        <div className="flex max-w-[380px] gap-3">
          {SHOWCASE.map((tile) => (
            <div
              key={tile.at}
              className={`hatch-night flex flex-1 items-end rounded-[10px] border border-white/8 p-2.5 ${tile.lift}`}
              style={{ aspectRatio: '9/16' }}
            >
              <span className="text-[10px] font-medium text-white/45">{tile.at}</span>
            </div>
          ))}
        </div>
        <blockquote className="m-0 max-w-[300px] font-display text-[19.5px] leading-[1.45] font-medium text-white/80">
          “I record one stream a week and post from it every day. This does the boring part.”
        </blockquote>
        <p className="m-0 text-[12px] text-white/40">Placeholder testimonial</p>
      </aside>
    </div>
  )
}
