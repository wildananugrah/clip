import { Button } from '../components/Button'
import { Meter } from '../components/Meter'
import { quota, storage } from '../lib/derive'
import { useApp } from '../state/AppContext'

function QuotaRow({
  label,
  value,
  width,
  tone,
}: {
  label: string
  value: string
  width: string
  tone?: 'ink' | 'sand'
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[12.5px] font-medium text-ink-soft">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <Meter value={width} tone={tone} className="h-[5px] rounded-[3px]" />
    </div>
  )
}

export function PlanScreen() {
  const { state, say } = useApp()
  const { usedLabel, width, resetDate } = quota(state.quota)
  const disk = storage(state.quota)

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-[26px] sm:px-7">
      <h1 className="m-0 mb-5 font-display text-[27px] font-bold tracking-[-0.025em] text-ink">
        Your plan
      </h1>

      <div className="flex max-w-[520px] flex-col gap-[18px]">
        <section className="rounded-[20px] border-[1.5px] border-[rgba(23,20,18,.16)] bg-white p-5">
          <div className="mb-4 flex items-center justify-between gap-2.5">
            <h2 className="m-0 text-[15px] font-semibold text-ink">Free beta</h2>
            <span className="rounded-[6px] bg-sand px-[9px] py-1 text-[11px] font-medium text-ink">
              no card on file
            </span>
          </div>

          <div className="flex flex-col gap-3.5">
            <QuotaRow label="Videos this month" value={usedLabel} width={width} />
            <QuotaRow
              label="Source length per video"
              value="up to 3 hrs"
              width="100%"
              tone="sand"
            />
            {/*
              Real bytes, from the server's sum over renders. The prototype
              hardcoded "1.2 GB of 5 GB", which read a quarter full on a full
              account -- and a full account is exactly when this row matters.
            */}
            <QuotaRow
              label="Storage"
              value={disk.known ? disk.label : '—'}
              width={disk.width}
              tone={disk.full ? 'ink' : undefined}
            />
          </div>

          <p className="mt-[18px] border-t border-black/8 pt-4 text-[12.5px] leading-[1.6] text-muted">
            Everything is free during the beta, watermark-free, up to 1080p.
            {resetDate && ` Limits reset on ${resetDate}.`}
          </p>
        </section>

        <section className="rounded-[20px] border-[1.5px] border-[rgba(23,20,18,.16)] bg-white px-5 py-[18px]">
          <h2 className="m-0 mb-2 text-[13.5px] font-semibold text-ink">Need more this month?</h2>
          <p className="m-0 mb-3.5 text-[12.5px] leading-[1.6] text-muted">
            Invite someone and you both get one extra video. No limit on invites.
          </p>
          <div className="flex gap-2">
            <div className="flex h-[38px] flex-1 items-center rounded-full border-[1.5px] border-[rgba(23,20,18,.45)] px-3 text-[12.5px] text-[#9A968F]">
              clip2.mhamzah.id/i/a7f3k
            </div>
            <Button
              onClick={() => say('Invite link copied.')}
              className="h-[38px] bg-ink px-[15px] text-[12.5px] hover:bg-ink"
            >
              Copy
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}
