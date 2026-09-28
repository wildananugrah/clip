import type { ReactNode } from 'react'
import { Button } from '../components/Button'
import { LazyImage } from '../components/LazyImage'
import { OptionChip } from '../components/OptionChip'
import { Toggle } from '../components/Toggle'
import { LENGTHS, RATIOS } from '../data/fixtures'
import { cn } from '../lib/cn'
import { formatsLabel } from '../lib/derive'
import { setThemePref, useThemePref, type ThemePref } from '../lib/theme'
import { useApp } from '../state/AppContext'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[20px] border-[1.5px] border-ink/16 bg-paper">
      <h2 className="m-0 border-b border-ink/7 px-[18px] py-3.5 text-[11px] font-semibold tracking-[.07em] text-ink/40 uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-[18px] py-4', className)}>{children}</div>
}

function RowTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="block">
      <span className="block text-[13px] font-medium text-ink">{title}</span>
      <span className="block text-[11.5px] text-ink/45">{hint}</span>
    </span>
  )
}

const divider = 'border-b border-ink/7'

const THEMES: Array<{ pref: ThemePref; label: string }> = [
  { pref: 'system', label: 'System' },
  { pref: 'light', label: 'Light' },
  { pref: 'dark', label: 'Dark' },
]

export function SettingsScreen() {
  const {
    state,
    cycleLength,
    toggleFormat,
    toggleSubs,
    toggleEmail,
    say,
    setPwCurrent,
    setPwNext,
    updatePassword,
    signOut,
  } = useApp()

  const themePref = useThemePref()

  const pwTooShort = state.pwNext.length > 0 && state.pwNext.length < 8
  const pwReady = Boolean(state.pwCurrent) && state.pwNext.length >= 8

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-[26px] sm:px-7">
      <h1 className="m-0 mb-5 font-display text-[27px] font-bold tracking-[-0.025em] text-ink">
        Settings
      </h1>

      <div className="flex max-w-[520px] flex-col gap-[18px]">
        <Card title="Defaults for new videos">
          <Row className={cn('flex items-center justify-between gap-3', divider)}>
            <RowTitle title="Clip length" hint="Applied to every new job" />
            <Button variant="quiet" onClick={cycleLength} className="h-8 px-3 text-[12.5px]">
              {LENGTHS[state.lengthIdx]} ▾
            </Button>
          </Row>

          <Row className={divider}>
            <div className="mb-[3px] text-[13px] font-medium text-ink">Formats to render</div>
            <div className="mb-[11px] text-[11.5px] text-ink/45">
              Currently {formatsLabel(state.formats)}
            </div>
            <div className="flex max-w-[300px] gap-1.5">
              {RATIOS.map((label) => (
                <OptionChip
                  key={label}
                  selected={state.formats[label]}
                  onClick={() => toggleFormat(label)}
                  className="h-[34px] rounded-full border-[1.5px]"
                >
                  {label}
                </OptionChip>
              ))}
            </div>
          </Row>

          <button
            type="button"
            onClick={toggleSubs}
            className={cn(
              'flex w-full cursor-pointer items-center justify-between gap-3 px-[18px] py-4 text-left',
              divider,
            )}
          >
            <RowTitle title="Burn in subtitles" hint="Bold, centred, bottom third" />
            <Toggle on={state.subs} label="Burn in subtitles" />
          </button>

          <button
            type="button"
            onClick={toggleEmail}
            className="flex w-full cursor-pointer items-center justify-between gap-3 px-[18px] py-4 text-left"
          >
            <RowTitle
              title="Email me when a job finishes"
              hint="Most jobs take under 10 minutes"
            />
            <Toggle on={state.emailMe} label="Email me when a job finishes" />
          </button>
        </Card>

        <Card title="Appearance">
          <Row>
            <div className="mb-[3px] text-[13px] font-medium text-ink">Theme</div>
            <div className="mb-[11px] text-[11.5px] text-ink/45">
              System follows your device. Saved on this browser.
            </div>
            <div role="group" aria-label="Theme" className="flex max-w-[300px] gap-1.5">
              {THEMES.map((t) => (
                <OptionChip
                  key={t.pref}
                  selected={themePref === t.pref}
                  onClick={() => setThemePref(t.pref)}
                  className="h-[34px] rounded-full border-[1.5px]"
                >
                  {t.label}
                </OptionChip>
              ))}
            </div>
          </Row>
        </Card>

        <Card title="Account">
          {/*
            The real session, not the prototype's hardcoded address. Sign out
            sits directly below, and a button that ends your session should say
            which account it is ending.
          */}
          <Row className={cn('flex items-center gap-3', divider)}>
            {state.user?.pictureUrl ? (
              <LazyImage
                src={state.user.pictureUrl}
                referrerPolicy="no-referrer"
                fallbackClassName="bg-sand-deeper"
                className="size-[34px] flex-none rounded-full"
              />
            ) : (
              <div className="size-[34px] flex-none rounded-full bg-sand-deeper" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">
                {/* Google does not always return a name. */}
                {state.user?.name ?? state.user?.email ?? 'Signed in'}
              </div>
              <div className="truncate text-[11.5px] text-ink/45">
                {state.user ? state.user.email : 'Checking your session…'}
              </div>
            </div>
          </Row>
          {/*
            Sign out lives here, not only in the sidebar. The sidebar is
            hidden below the md breakpoint, which left phones with no way to
            sign out of the app at all.
          */}
          <Row className={cn('flex items-center justify-between gap-3', divider)}>
            <span className="text-[13px] font-medium text-ink">Sign out of this device</span>
            <button
              type="button"
              onClick={signOut}
              disabled={state.pending === 'signOut'}
              aria-busy={state.pending === 'signOut' || undefined}
              className="flex h-10 cursor-pointer items-center text-[12.5px] font-medium text-violet hover:text-violet-deep disabled:cursor-not-allowed disabled:text-ink/35 md:h-auto"
            >
              {state.pending === 'signOut' ? 'Signing out…' : 'Sign out'}
            </button>
          </Row>
          <Row className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-ink">Delete account and all clips</span>
            <button
              type="button"
              onClick={() => say('Not in this prototype.')}
              className="flex h-10 cursor-pointer items-center text-[12.5px] font-medium text-danger md:h-auto"
            >
              Delete
            </button>
          </Row>
        </Card>

        <Card title="Password">
          <form
            className="flex flex-col gap-[11px] px-[18px] py-4"
            onSubmit={(e) => {
              e.preventDefault()
              updatePassword()
            }}
          >
            <label htmlFor="pw-current" className="text-[12px] font-medium text-ink-soft">
              Current password
            </label>
            <input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={state.pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
              placeholder="••••••••"
              className="h-10 rounded-full border-[1.5px] border-ink/30 px-3.5 text-[13px] text-ink outline-none focus:border-violet"
            />

            <label htmlFor="pw-next" className="text-[12px] font-medium text-ink-soft">
              New password
            </label>
            <input
              id="pw-next"
              type="password"
              autoComplete="new-password"
              value={state.pwNext}
              onChange={(e) => setPwNext(e.target.value)}
              placeholder="At least 8 characters"
              aria-describedby="pw-hint"
              className="h-10 rounded-full border-[1.5px] border-ink/30 px-3.5 text-[13px] text-ink outline-none focus:border-violet"
            />

            <p
              id="pw-hint"
              className={cn('m-0 text-[11.5px]', pwTooShort ? 'text-danger' : 'text-ink/42')}
            >
              {pwTooShort
                ? 'A bit longer — 8 characters minimum.'
                : 'You’ll stay signed in on this device.'}
            </p>

            <Button type="submit" armed={pwReady} className="h-10 self-start px-[18px] text-[13px]">
              Update password
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
