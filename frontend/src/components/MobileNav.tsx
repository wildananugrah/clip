import { cn } from '../lib/cn'
import { jobIndicator, quota } from '../lib/derive'
import { useApp } from '../state/AppContext'
import type { Screen } from '../types'
import { Button } from './Button'
import { JobIndicator } from './JobIndicator'
import { Logo } from './Logo'

const NAV: Array<{ label: string; screen: Screen }> = [
  { label: 'Projects', screen: 'projects' },
  { label: 'Latest clips', screen: 'results' },
  { label: 'Plan', screen: 'plan' },
  { label: 'Settings', screen: 'settings' },
]

/** Stands in for the sidebar below the medium breakpoint. */
export function MobileNav() {
  const { state, go, goNew, goResults } = useApp()
  const job = jobIndicator(state)

  return (
    <div className="flex-none border-b border-ink/8 bg-paper px-4 py-3 md:hidden">
      <div className="flex items-center gap-3">
        <Logo size="sm" />
        <span className="ml-auto text-[11.5px] text-ink/45">{quota(state.quota).label}</span>
        <Button onClick={goNew} className="h-10 px-3.5 text-[12px]">
          + New
        </Button>
      </div>
      <JobIndicator
        indicator={job}
        variant="nav"
        current={state.screen === job.target}
        onOpen={() => go(job.target)}
      />

      <div className="-mx-1 mt-2 flex gap-1 overflow-x-auto">
        {NAV.map((item) => {
          const active = state.screen === item.screen
          return (
            <button
              key={item.screen}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => (item.screen === 'results' ? goResults() : go(item.screen))}
              className={cn(
                'flex h-10 flex-none cursor-pointer items-center rounded-[8px] px-3 text-[12.5px] font-medium',
                active ? 'bg-cream text-ink' : 'text-muted',
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
