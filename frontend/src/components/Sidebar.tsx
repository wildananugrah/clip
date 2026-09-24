import { cn } from '../lib/cn'
import { jobIndicator, quota } from '../lib/derive'
import { useApp } from '../state/AppContext'
import type { Screen } from '../types'
import { Button } from './Button'
import { JobIndicator } from './JobIndicator'
import { Logo } from './Logo'
import { Meter } from './Meter'

const NAV: Array<{ label: string; screen: Screen }> = [
  { label: 'Projects', screen: 'projects' },
  { label: 'Latest clips', screen: 'results' },
  { label: 'Plan & limits', screen: 'plan' },
  { label: 'Settings', screen: 'settings' },
]

export function Sidebar() {
  const { state, goNew, go, goResults, signOut, cancelJob } = useApp()
  const allowance = quota(state.quota)
  const job = jobIndicator(state)

  return (
    <nav className="hidden w-[212px] flex-none flex-col border-r border-black/8 bg-white px-3.5 py-[18px] md:flex">
      <div className="px-1.5 pb-[18px]">
        <Logo size="sm" />
      </div>

      <Button onClick={goNew} className="mb-4 h-[38px] text-[13px]">
        + New video
      </Button>

      <div className="flex flex-col gap-0.5">
        {/* Only rendered while there is a job worth reporting. */}
        <JobIndicator
          indicator={job}
          variant="nav"
          current={state.screen === job.target}
          onOpen={() => go(job.target)}
          onCancel={() => cancelJob()}
          cancelling={state.pending === 'cancelJob'}
        />

        {NAV.map((item) => {
          const active = state.screen === item.screen
          return (
            <button
              key={item.screen}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => (item.screen === 'results' ? goResults() : go(item.screen))}
              className={cn(
                'flex h-[34px] cursor-pointer items-center rounded-[8px] px-2.5 text-left text-[13px] font-medium transition-colors',
                active ? 'bg-cream text-ink' : 'text-muted hover:bg-cream/70',
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>

      {/*
        Hidden until the server answers: showing a number before then is how this
        block used to claim a full allowance after a video had been generated.
      */}
      {allowance.known && (
        <div className="mt-auto rounded-[9px] bg-cream p-3">
          <div
            className={cn(
              'mb-1.5 text-[12px] font-medium',
              allowance.exhausted ? 'text-[#8C2F2F]' : 'text-ink',
            )}
          >
            {allowance.label}
          </div>
          <Meter value={allowance.width} className="mb-2 h-1 rounded-[2px]" />
          <p className="m-0 text-[11.5px] leading-[1.45] text-black/45">
            {/* A rolling 24h window, not a calendar month. */}
            {allowance.resetLabel || 'Clips stay for 30 days.'}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={signOut}
        disabled={state.pending === 'signOut'}
        aria-busy={state.pending === 'signOut' || undefined}
        className="mt-2.5 cursor-pointer px-1.5 text-left text-[11.5px] font-medium text-black/40 hover:text-ink disabled:cursor-not-allowed"
      >
        {state.pending === 'signOut' ? 'Signing out…' : 'Sign out'}
      </button>
    </nav>
  )
}
